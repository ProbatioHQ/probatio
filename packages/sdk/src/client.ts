import { DEFAULT_API_BASE } from './constants';
import { ProbatioError, getProof, getRecord, getStandings, type ReadOptions } from './read';
import { verifyRecord, type VerifyOptions } from './verify';
import type { ProfileRecord, ProofBundle, Standings, VerifiedRecord } from './types';

/**
 * A configured client, so the base URL, RPC and fetch are set once.
 *
 * ```ts
 * const probatio = new Probatio({ rpc: 'https://api.mainnet-beta.solana.com' });
 * const result = await probatio.verifyRecord(wallet);
 * if (result.verified) console.log('checks out against the chain');
 * ```
 *
 * Every method also exists as a standalone function for callers who prefer not
 * to hold an instance.
 */
export interface ProbatioConfig {
  /** Base URL of a Probatio instance. Defaults to https://probatio.app. */
  readonly apiBase?: string;
  /** A Solana RPC endpoint, used by `verifyRecord`. */
  readonly rpc?: string;
  /** Injected fetch, for tests or a non-browser runtime. */
  readonly fetchImpl?: typeof fetch;
  /** Override the program id. Defaults to the canonical one. */
  readonly programId?: string;
}

export class Probatio {
  readonly #config: ProbatioConfig;

  constructor(config: ProbatioConfig = {}) {
    this.#config = config;
  }

  /** The base URL this client reads from. */
  get apiBase(): string {
    return this.#config.apiBase ?? DEFAULT_API_BASE;
  }

  #read(): ReadOptions {
    return { apiBase: this.#config.apiBase, fetchImpl: this.#config.fetchImpl };
  }

  /** The raw inputs to check a record. A season ordinal, or the latest committed. */
  getProof(trader: string, options: { readonly season?: number } = {}): Promise<ProofBundle> {
    return getProof(trader, { ...this.#read(), season: options.season });
  }

  /** A trader's public record. */
  getRecord(trader: string): Promise<ProfileRecord> {
    return getRecord(trader, this.#read());
  }

  /** A season's standings, or the current one when none is named. */
  getStandings(options: { readonly season?: number; readonly limit?: number } = {}): Promise<Standings> {
    return getStandings({ ...this.#read(), season: options.season, limit: options.limit });
  }

  /** Verify a record against the chain. Needs an rpc, from here or the config. */
  verifyRecord(
    trader: string,
    options: { readonly season?: number; readonly rpc?: string } = {},
  ): Promise<VerifiedRecord> {
    const rpc = options.rpc ?? this.#config.rpc;
    if (!rpc) throw new ProbatioError('no rpc endpoint configured; pass one to the client or the call');
    const verifyOptions: VerifyOptions = {
      rpc,
      apiBase: this.#config.apiBase,
      fetchImpl: this.#config.fetchImpl,
      programId: this.#config.programId,
      season: options.season,
    };
    return verifyRecord(trader, verifyOptions);
  }
}
