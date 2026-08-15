import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { RpcClient } from '@probatio/pools';
import { compileMessage, encodeMessage, encodeCompactU16, type Instruction } from '@probatio/payments';
import {
  PROGRAM_ID,
  VaultError,
  finalizeSeason,
  initConfig,
  initSeason,
  openEntries,
  startTrading,
  voidSeason,
  type SeasonParams,
} from './index';

/**
 * The operator's authority key, and the only thing that holds it.
 *
 * Where the keeper key may only append trade records, this key runs the season:
 * it creates it, opens and closes its entries, and finalizes it against the
 * results root. It never moves prize money — `claim_prize` and `refund_entry`
 * are signed by the trader being paid, from a route, not by this. So a leak of
 * this key can grief a season (void it, finalize it early) but cannot drain a
 * vault to itself; the vault only ever pays the address a signed entry names.
 *
 * The transaction shape is the keeper's: compile a single-instruction message,
 * sign it, prepend the one signature, send, and wait for the chain to confirm.
 */

export interface AuthorityReceipt {
  readonly signature: string;
  readonly slot: number;
}

export interface AuthorityGatewayOptions {
  readonly rpc: RpcClient;
  /** The 64-byte authority keypair (secret + public), not the seed alone. */
  readonly authoritySecret: Uint8Array;
  readonly programId?: string;
  readonly confirmTimeoutMs?: number;
}

export class AuthorityGateway {
  readonly #rpc: RpcClient;
  readonly #secret: Uint8Array;
  readonly #public: string;
  readonly #programId: string;
  readonly #confirmTimeoutMs: number;

  constructor(options: AuthorityGatewayOptions) {
    if (options.authoritySecret.length !== 64) {
      throw new VaultError(
        `an authority key is 64 bytes, got ${options.authoritySecret.length}. This is the ` +
          'full keypair, not the seed alone.',
      );
    }
    this.#rpc = options.rpc;
    this.#secret = options.authoritySecret.subarray(0, 32);
    this.#programId = options.programId ?? PROGRAM_ID;
    this.#confirmTimeoutMs = options.confirmTimeoutMs ?? 60_000;

    const derived = ed25519.getPublicKey(this.#secret);
    const declared = options.authoritySecret.subarray(32);
    if (!derived.every((byte, index) => byte === declared[index])) {
      throw new VaultError('the keypair does not match itself');
    }
    this.#public = bs58.encode(derived);
  }

  /** The authority's public key, and the address a season is created under. */
  get authority(): string {
    return this.#public;
  }

  async #send(instruction: Instruction): Promise<AuthorityReceipt> {
    const { blockhash } = await this.#rpc.getLatestBlockhash();
    const message = encodeMessage(compileMessage(this.#public, blockhash, [instruction]));
    const signature = ed25519.sign(message, this.#secret);

    const transaction = new Uint8Array(1 + 64 + message.length);
    transaction.set(encodeCompactU16(1), 0);
    transaction.set(signature, 1);
    transaction.set(message, 65);

    const sent = await this.#rpc.sendTransaction(Buffer.from(transaction).toString('base64'));
    const settled = await this.#rpc.confirmSignature(sent, { timeoutMs: this.#confirmTimeoutMs });
    if (!settled.confirmed) {
      throw new VaultError(
        settled.err
          ? `transaction failed on chain: ${JSON.stringify(settled.err)}`
          : `transaction ${sent} did not confirm in time; its outcome is unknown`,
      );
    }
    return { signature: sent, slot: settled.slot ?? 0 };
  }

  /** Name the admin who may create seasons. Called once, when standing up. */
  initConfig(admin: string): Promise<AuthorityReceipt> {
    return this.#send(initConfig({ payer: this.#public, admin, programId: this.#programId }));
  }

  /** Create the season and its vault on chain. Pays the vault's rent. */
  createSeason(params: SeasonParams): Promise<AuthorityReceipt> {
    return this.#send(initSeason({ authority: this.#public, params, programId: this.#programId }));
  }

  /** Move a pending season to accepting entries. */
  openEntries(ordinal: number): Promise<AuthorityReceipt> {
    return this.#send(openEntries({ authority: this.#public, ordinal, programId: this.#programId }));
  }

  /** Close entries and start the season running. */
  startTrading(ordinal: number): Promise<AuthorityReceipt> {
    return this.#send(startTrading({ authority: this.#public, ordinal, programId: this.#programId }));
  }

  /** Publish the results root, moving the season to Finalized so winners can claim. */
  finalizeSeason(ordinal: number, resultsRoot: Uint8Array): Promise<AuthorityReceipt> {
    return this.#send(
      finalizeSeason({ authority: this.#public, ordinal, resultsRoot, programId: this.#programId }),
    );
  }

  /** Cancel a season so its entries can be refunded. */
  voidSeason(ordinal: number): Promise<AuthorityReceipt> {
    return this.#send(voidSeason({ authority: this.#public, ordinal, programId: this.#programId }));
  }
}
