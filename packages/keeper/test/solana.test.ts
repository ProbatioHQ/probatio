import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeMessage } from '@probatio/payments';
import { GatewayError } from '../src/gateway';
import {
  COMMIT_ROOT_DISCRIMINATOR,
  PROGRAM_ID,
  SolanaGateway,
  TRADER_RECORD_DISCRIMINATOR,
  anchorDiscriminator,
  commitRootInstruction,
  decodeTraderRecord,
  recordAddress,
  seasonAddress,
} from '../src/solana';

const TRADER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const KEEPER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The program's own IDL, read rather than remembered.
 *
 * Everything below that pins a byte pins it against this file. An encoding
 * that drifts from the program does not fail loudly — it fails as a rejected
 * transaction with an opaque error, on a cluster, after paying a fee.
 */
const idl = JSON.parse(
  readFileSync(new URL('../../../program/idl/probatio.json', import.meta.url), 'utf8'),
) as {
  address: string;
  instructions: {
    name: string;
    discriminator: number[];
    accounts: { name: string; signer?: boolean; writable?: boolean }[];
  }[];
  accounts: { name: string; discriminator: number[] }[];
};

const commitRoot = idl.instructions.find((ix) => ix.name === 'commit_root')!;

describe('agreeing with the program', () => {
  it('computes the discriminator Anchor uses', () => {
    expect(hex(anchorDiscriminator('commit_root'))).toBe(hex(Uint8Array.from(commitRoot.discriminator)));
  });

  it('pins the constant against the IDL too', () => {
    // The constant is exported, so a wrong one is a landmine for a caller who
    // trusts it instead of computing it.
    expect(COMMIT_ROOT_DISCRIMINATOR).toBe(hex(Uint8Array.from(commitRoot.discriminator)));
  });

  it('pins the account record discriminator', () => {
    const record = idl.accounts.find((account) => account.name === 'TraderRecord')!;
    expect(TRADER_RECORD_DISCRIMINATOR).toBe(hex(Uint8Array.from(record.discriminator)));
  });

  it('uses the program the IDL was built for', () => {
    expect(PROGRAM_ID).toBe(idl.address);
  });

  it('passes accounts in the order the IDL declares', () => {
    // Anchor matches accounts by position, so a swapped pair is a valid
    // transaction that does the wrong thing rather than an error.
    const instruction = commitRootInstruction({
      keeper: KEEPER,
      season: TRADER,
      trader: TRADER,
      record: KEEPER,
      batchRoot: new Uint8Array(32).fill(7),
      leaves: 3,
      engineVersion: 1,
    });

    expect(instruction.keys).toHaveLength(commitRoot.accounts.length);
    commitRoot.accounts.forEach((account, index) => {
      expect(instruction.keys[index]!.isSigner).toBe(account.signer === true);
      expect(instruction.keys[index]!.isWritable).toBe(account.writable === true);
    });
  });
});

describe('encoding the instruction', () => {
  const instruction = commitRootInstruction({
    keeper: KEEPER,
    season: TRADER,
    trader: TRADER,
    record: KEEPER,
    batchRoot: new Uint8Array(32).fill(0xab),
    leaves: 300,
    engineVersion: 2,
  });

  it('is discriminator, root, then two little-endian counts', () => {
    expect(instruction.data).toHaveLength(48);
    expect(hex(instruction.data.subarray(0, 8))).toBe(COMMIT_ROOT_DISCRIMINATOR);
    expect(hex(instruction.data.subarray(8, 40))).toBe('ab'.repeat(32));

    const view = new DataView(
      instruction.data.buffer,
      instruction.data.byteOffset,
      instruction.data.byteLength,
    );
    expect(view.getUint32(40, true)).toBe(300);
    expect(view.getUint32(44, true)).toBe(2);
  });

  it('refuses a root that is not 32 bytes', () => {
    expect(() =>
      commitRootInstruction({
        keeper: KEEPER,
        season: TRADER,
        trader: TRADER,
        record: KEEPER,
        batchRoot: new Uint8Array(31),
        leaves: 1,
        engineVersion: 1,
      }),
    ).toThrow(GatewayError);
  });

  it('refuses an empty batch', () => {
    expect(() =>
      commitRootInstruction({
        keeper: KEEPER,
        season: TRADER,
        trader: TRADER,
        record: KEEPER,
        batchRoot: new Uint8Array(32),
        leaves: 0,
        engineVersion: 1,
      }),
    ).toThrow(GatewayError);
  });
});

describe('addresses', () => {
  it('derives a season from its ordinal, little endian', () => {
    // The seed is `ordinal.to_le_bytes()` on an i16. Getting the width or the
    // order wrong produces a valid address for the wrong season.
    const one = seasonAddress(1);
    const two = seasonAddress(2);
    expect(one.address).not.toBe(two.address);
    expect(bs58.decode(one.address)).toHaveLength(32);
  });

  it('handles free play, whose ordinal is negative', () => {
    expect(() => seasonAddress(-1)).not.toThrow();
    expect(seasonAddress(-1).address).not.toBe(seasonAddress(1).address);
  });

  it('derives a record from the season and the trader', () => {
    const season = seasonAddress(1).address;
    expect(recordAddress(season, TRADER).address).not.toBe(recordAddress(season, KEEPER).address);
  });

  it('gives the same address every time', () => {
    expect(seasonAddress(1).address).toBe(seasonAddress(1).address);
  });
});

describe('decoding a record', () => {
  function record(overrides: { accumulator?: string; commits?: number; leaves?: bigint } = {}) {
    const data = new Uint8Array(133);
    data.set(
      Uint8Array.from(
        TRADER_RECORD_DISCRIMINATOR.match(/../g)!.map((byte) => parseInt(byte, 16)),
      ),
      0,
    );
    const accumulator = overrides.accumulator ?? 'cd'.repeat(32);
    data.set(
      Uint8Array.from(accumulator.match(/../g)!.map((byte) => parseInt(byte, 16))),
      72,
    );
    const view = new DataView(data.buffer);
    view.setUint32(104, overrides.commits ?? 4, true);
    view.setBigUint64(108, overrides.leaves ?? 40n, true);
    return data;
  }

  it('reads the accumulator, count and leaves', () => {
    const decoded = decodeTraderRecord(record());
    expect(decoded.accumulator).toBe('cd'.repeat(32));
    expect(decoded.commitCount).toBe(4);
    expect(decoded.leafCount).toBe(40);
  });

  it('refuses an account that is not a trader record', () => {
    // Without the check, a different account at the same address decodes into
    // plausible numbers and the keeper compares its chain against noise.
    const wrong = record();
    wrong[0] = 0;
    expect(() => decodeTraderRecord(wrong)).toThrow(/not a trader record/);
  });

  it('refuses an account too short to hold one', () => {
    expect(() => decodeTraderRecord(new Uint8Array(64))).toThrow(GatewayError);
  });
});

describe('the keeper key', () => {
  const seed = new Uint8Array(32).fill(3);
  const secret = new Uint8Array(64);
  secret.set(seed, 0);
  secret.set(ed25519.getPublicKey(seed), 32);

  it('derives its own public key', () => {
    const gateway = new SolanaGateway({ rpc: {} as never, keeperSecret: secret });
    expect(gateway.keeper).toBe(bs58.encode(ed25519.getPublicKey(seed)));
  });

  it('refuses a seed on its own', () => {
    // A 32-byte file is the seed, not the keypair. Accepting it would sign
    // with a key whose public half nobody checked.
    expect(() => new SolanaGateway({ rpc: {} as never, keeperSecret: seed })).toThrow(/64 bytes/);
  });

  it('refuses a keypair whose halves disagree', () => {
    const corrupted = new Uint8Array(secret);
    corrupted[40] = (corrupted[40] ?? 0) ^ 0xff;
    expect(() => new SolanaGateway({ rpc: {} as never, keeperSecret: corrupted })).toThrow(
      /does not match itself/,
    );
  });
});

describe('the transaction it signs', () => {
  it('carries one signature that verifies over the message', async () => {
    const seed = new Uint8Array(32).fill(9);
    const secret = new Uint8Array(64);
    secret.set(seed, 0);
    secret.set(ed25519.getPublicKey(seed), 32);

    let submitted = '';
    const rpc = {
      getLatestBlockhash: async () => ({
        blockhash: bs58.encode(new Uint8Array(32).fill(1)),
        lastValidBlockHeight: 1,
      }),
      sendTransaction: async (base64: string) => {
        submitted = base64;
        return 'sig';
      },
      confirmSignature: async () => ({ confirmed: true, slot: 10, err: null }),
    };

    const gateway = new SolanaGateway({ rpc: rpc as never, keeperSecret: secret });
    await gateway.commitRoot({
      seasonOrdinal: 1,
      trader: TRADER,
      merkleRoot: 'ab'.repeat(32),
      leaves: 5,
      engineVersion: 1,
    });

    const bytes = Uint8Array.from(Buffer.from(submitted, 'base64'));
    expect(bytes[0]).toBe(1);

    const signature = bytes.subarray(1, 65);
    const message = bytes.subarray(65);

    // The signature has to verify against the message actually sent, not
    // against one built the same way a second time.
    expect(ed25519.verify(signature, message, ed25519.getPublicKey(seed))).toBe(true);

    const decoded = decodeMessage(message);
    expect(decoded.accountKeys[0]).toBe(gateway.keeper);
    expect(decoded.instructions).toHaveLength(1);
  });

  it('refuses a root that is not hex', () => {
    const seed = new Uint8Array(32).fill(5);
    const secret = new Uint8Array(64);
    secret.set(seed, 0);
    secret.set(ed25519.getPublicKey(seed), 32);

    const gateway = new SolanaGateway({ rpc: {} as never, keeperSecret: secret });
    return expect(
      gateway.commitRoot({
        seasonOrdinal: 1,
        trader: TRADER,
        merkleRoot: 'not-a-root',
        leaves: 1,
        engineVersion: 1,
      }),
    ).rejects.toThrow(GatewayError);
  });
});
