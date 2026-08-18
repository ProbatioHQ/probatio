import { Probatio } from '@probatio/sdk';
import type { ProfileRecord, ProofBundle, SeasonInfo, Standings, VerifiedRecord } from '@probatio/sdk';

/**
 * The tools, apart from the transport.
 *
 * The handlers are plain async functions over the SDK, so they can be tested
 * without standing up a server. `server.ts` is the only part that knows about
 * MCP, and all it does is describe these and forward the calls.
 */

export interface ToolConfig {
  /** A Probatio instance. Defaults to https://probatiotrade.com. */
  readonly apiBase?: string | undefined;
  /** A Solana RPC endpoint, used by verify_record when the call omits one. */
  /** Injected fetch, for tests. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface ProbatioTools {
  verifyRecord(input: {
    wallet: string;
    season?: number | undefined;
  }): Promise<VerifiedRecord>;
  getRecord(input: { wallet: string }): Promise<ProfileRecord>;
  getStandings(input: { limit?: number | undefined }): Promise<Standings>;
  getSeason(): Promise<SeasonInfo>;
  getProof(input: { wallet: string; season?: number | undefined }): Promise<ProofBundle>;
}

export function createTools(config: ToolConfig = {}): ProbatioTools {
  const probatio = new Probatio({
    apiBase: config.apiBase,
    fetchImpl: config.fetchImpl,
  });

  return {
    verifyRecord: (input) => probatio.verifyRecord(input.wallet, { season: input.season }),
    getRecord: (input) => probatio.getRecord(input.wallet),
    getStandings: (input) => probatio.getStandings({ limit: input.limit }),
    getSeason: () => probatio.getSeason(),
    getProof: (input) => probatio.getProof(input.wallet, { season: input.season }),
  };
}
