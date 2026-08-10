import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { RpcClient, findProgramAddress, readU64, type DerivedAddress } from '@probatio/pools';
import {
  compileMessage,
  encodeMessage,
  encodeCompactU16,
  type Instruction,
} from '@probatio/payments';
import { GatewayError, type ChainGateway, type CommitReceipt, type OnChainRecord } from './gateway';

/**
 * The keeper's gateway to a real cluster.
 *
 * Everything above this was written against an interface, which meant nothing
 * had ever been committed: the only implementations were test doubles, so
 * `/verify` reported nothing for everybody and the central claim of the product
 * was unfulfilled. This is the piece that makes a record exist.
 *
 * The instruction is encoded by hand, like every other Solana structure here.
 * The discriminator and the account order come from the program's own IDL
 * rather than from a reading of the source, and a test pins them — an encoding
 * that drifts from the program does not fail loudly, it fails as a rejected
 * transaction with an opaque error.
 */

/**
 * The address the program is deployed to.
 *
 * Kept in step with the keypair by a test that reads the IDL. They were out of
 * step until the first real deployment: the source declared one address and the
 * keypair we hold is another, so every instruction would have been rejected by
 * a program that had deployed successfully. Nothing catches that except
 * deploying.
 */
export const PROGRAM_ID = 'HRGEAiqX4qw7B1fgNsR64oRAKF4QwkjkZFx9YXDFxaXA';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

const SEASON_SEED = new TextEncoder().encode('season');
const RECORD_SEED = new TextEncoder().encode('record');

/** Anchor names an instruction by the first eight bytes of this hash. */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
}

/**
 * From the program's own IDL, and pinned by a test that reads it.
 *
 * Typing one of these from memory is how an encoding drifts from the program
 * it is meant to call — and the failure is not loud, it is a rejected
 * transaction with an opaque error.
 */
export const COMMIT_ROOT_DISCRIMINATOR = '8ef251f827eec27d';
export const TRADER_RECORD_DISCRIMINATOR = 'f9159451b5a2ad97';

export function seasonAddress(ordinal: number, programId = PROGRAM_ID): DerivedAddress {
  // i16, little endian — matching `params.ordinal.to_le_bytes()` in the seed.
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, ordinal, true);
  return findProgramAddress([SEASON_SEED, bytes], programId);
}

export function recordAddress(
  season: string,
  trader: string,
  programId = PROGRAM_ID,
): DerivedAddress {
  return findProgramAddress([RECORD_SEED, bs58.decode(season), bs58.decode(trader)], programId);
}

/** The `commit_root` instruction, encoded. */
export function commitRootInstruction(input: {
  readonly keeper: string;
  readonly season: string;
  readonly trader: string;
  readonly record: string;
  readonly batchRoot: Uint8Array;
  readonly leaves: number;
  readonly engineVersion: number;
  readonly programId?: string;
}): Instruction {
  if (input.batchRoot.length !== 32) {
    throw new GatewayError(`a batch root is 32 bytes, got ${input.batchRoot.length}`);
  }
  if (input.leaves <= 0) throw new GatewayError('a batch must contain at least one leaf');

  const data = new Uint8Array(8 + 32 + 4 + 4);
  data.set(anchorDiscriminator('commit_root'), 0);
  data.set(input.batchRoot, 8);

  const view = new DataView(data.buffer);
  view.setUint32(40, input.leaves, true);
  view.setUint32(44, input.engineVersion, true);

  return {
    programId: input.programId ?? PROGRAM_ID,
    // Order is the IDL's, and it is not negotiable — Anchor matches accounts by
    // position, so a swapped pair is a valid transaction that does the wrong
    // thing.
    keys: [
      { pubkey: input.keeper, isSigner: true, isWritable: true },
      { pubkey: input.season, isSigner: false, isWritable: false },
      { pubkey: input.trader, isSigner: false, isWritable: false },
      { pubkey: input.record, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  };
}

/**
 * Decode a TraderRecord account.
 *
 * The discriminator is checked first. Without it, a different account at the
 * same address — or an account of a different type — decodes into plausible
 * numbers rather than failing, and the keeper would compare its accumulator
 * against noise.
 */
export function decodeTraderRecord(data: Uint8Array): OnChainRecord {
  if (data.length < 133) {
    throw new GatewayError(`trader record is too short: ${data.length} bytes`);
  }

  const discriminator = [...data.subarray(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (discriminator !== TRADER_RECORD_DISCRIMINATOR) {
    throw new GatewayError(`not a trader record: discriminator ${discriminator}`);
  }

  // 8 discriminator, 32 season, 32 trader, then the accumulator.
  const accumulator = [...data.subarray(72, 104)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  return {
    accumulator,
    commitCount: view.getUint32(104, true),
    leafCount: Number(readU64(data, 108)),
  };
}

export interface SolanaGatewayOptions {
  readonly rpc: RpcClient;
  /** 64 bytes: the secret followed by the public key, as Solana stores them. */
  readonly keeperSecret: Uint8Array;
  readonly programId?: string;
  /** How long to wait for a signature to settle before giving up on it. */
  readonly confirmTimeoutMs?: number;
}

export class SolanaGateway implements ChainGateway {
  readonly #rpc: RpcClient;
  readonly #secret: Uint8Array;
  readonly #public: string;
  readonly #programId: string;
  readonly #confirmTimeoutMs: number;

  constructor(options: SolanaGatewayOptions) {
    if (options.keeperSecret.length !== 64) {
      throw new GatewayError(
        `a keeper key is 64 bytes, got ${options.keeperSecret.length}. This is the ` +
          'full keypair, not the seed alone.',
      );
    }

    this.#rpc = options.rpc;
    this.#secret = options.keeperSecret.subarray(0, 32);
    this.#programId = options.programId ?? PROGRAM_ID;
    this.#confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;

    const derived = ed25519.getPublicKey(this.#secret);
    const declared = options.keeperSecret.subarray(32);
    if (!derived.every((byte, index) => byte === declared[index])) {
      // A keypair whose halves disagree is a corrupted file, and signing with
      // it produces transactions the cluster silently rejects.
      throw new GatewayError('the keypair does not match itself');
    }
    this.#public = bs58.encode(derived);
  }

  get keeper(): string {
    return this.#public;
  }

  async commitRoot(input: {
    seasonOrdinal: number;
    trader: string;
    merkleRoot: string;
    leaves: number;
    engineVersion: number;
  }): Promise<CommitReceipt> {
    const season = seasonAddress(input.seasonOrdinal, this.#programId).address;
    const record = recordAddress(season, input.trader, this.#programId).address;

    const instruction = commitRootInstruction({
      keeper: this.#public,
      season,
      trader: input.trader,
      record,
      batchRoot: hexToBytes(input.merkleRoot),
      leaves: input.leaves,
      engineVersion: input.engineVersion,
      programId: this.#programId,
    });

    const { blockhash } = await this.#rpc.getLatestBlockhash();
    const message = encodeMessage(compileMessage(this.#public, blockhash, [instruction]));
    const signature = ed25519.sign(message, this.#secret);

    const transaction = new Uint8Array(1 + 64 + message.length);
    transaction.set(encodeCompactU16(1), 0);
    transaction.set(signature, 1);
    transaction.set(message, 65);

    const sent = await this.#rpc.sendTransaction(Buffer.from(transaction).toString('base64'));
    const settled = await this.#rpc.confirmSignature(sent, {
      timeoutMs: this.#confirmTimeoutMs,
    });

    if (!settled.confirmed) {
      // Rejecting does not mean it failed to land. The keeper treats a
      // rejection as unknown and settles it by reading the chain, which is the
      // only thing that knows.
      throw new GatewayError(
        settled.err
          ? `commit failed on chain: ${JSON.stringify(settled.err)}`
          : `commit ${sent} did not confirm in time; its outcome is unknown`,
      );
    }

    return { signature: sent, slot: settled.slot ?? 0 };
  }

  async readRecord(seasonOrdinal: number, trader: string): Promise<OnChainRecord | null> {
    const season = seasonAddress(seasonOrdinal, this.#programId).address;
    const record = recordAddress(season, trader, this.#programId).address;

    const account = await this.#rpc.getAccount(record);
    if (!account) return null;

    if (account.owner !== this.#programId) {
      throw new GatewayError(`record account at ${record} is owned by ${account.owner}`);
    }

    return decodeTraderRecord(account.data);
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new GatewayError(`expected a 32-byte hex root, got "${hex}"`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
