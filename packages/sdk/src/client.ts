import { DEFAULT_API_BASE } from './constants';
import { ProbatioError, getProof, getRecord, getSeason, getStandings, type ReadOptions } from './read';
import { verifyRecord, type VerifyOptions } from './verify';
import type { ProfileRecord, ProofBundle, SeasonInfo, Standings, VerifiedRecord } from './types';

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
  /** Base URL of a Probatio instance. Defaults to https://probatiotrade.com. */
  readonly apiBase?: string | undefined;
  /** A Solana RPC endpoint, used by `verifyRecord`. */
  readonly rpc?: string | undefined;
  /** Injected fetch, for tests or a non-browser runtime. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Override the program id. Defaults to the canonical one. */
  readonly programId?: string | undefined;
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
  getProof(trader: string, options: { readonly season?: number | undefined } = {}): Promise<ProofBundle> {
    return getProof(trader, { ...this.#read(), season: options.season });
  }

  /** A trader's public record. */
  getRecord(trader: string): Promise<ProfileRecord> {
    return getRecord(trader, this.#read());
  }

  /** The standings of the current ranked season. */
  getStandings(options: { readonly limit?: number | undefined } = {}): Promise<Standings> {
    return getStandings({ ...this.#read(), limit: options.limit });
  }

  /** The current ranked season: pot, projected payouts, and the ruleset hash to check. */
  getSeason(): Promise<SeasonInfo> {
    return getSeason(this.#read());
  }

  /**
   * Verify a record. Nothing else is needed: no endpoint, no key, no network
   * beyond fetching the record itself, and the checking is arithmetic done here.
   */
  verifyRecord(
    trader: string,
    options: { readonly season?: number | undefined } = {},
  ): Promise<VerifiedRecord> {
    const verifyOptions: VerifyOptions = {
      apiBase: this.#config.apiBase,
      fetchImpl: this.#config.fetchImpl,
      season: options.season,
    };
    return verifyRecord(trader, verifyOptions);
  }
}
