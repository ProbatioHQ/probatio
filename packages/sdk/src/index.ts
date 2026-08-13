/**
 * @probatio/sdk
 *
 * Read a Probatio trading record, and check it against the chain yourself.
 *
 * The point of Probatio is that a record does not need Probatio to be believed.
 * This is that in a library: it fetches the trades a trader committed, rebuilds
 * their hashes, folds them into an accumulator, and compares it to the one
 * Solana holds, at an address derived from constants in this package, over an
 * RPC you choose. A `verified: true` never comes from a server's say-so.
 */

export { Probatio } from './client';
export type { ProbatioConfig } from './client';

export { verifyRecord, verifyBundle } from './verify';
export type { VerifyOptions } from './verify';

export { ProbatioError, getProof, getRecord, getSeason, getStandings } from './read';
export type { ReadOptions } from './read';

export { DEFAULT_API_BASE, PROGRAM_ID } from './constants';

export type {
  AmountField,
  ProfileRecord,
  ProfileSeason,
  ProofBatch,
  ProofBundle,
  RankedSeason,
  RawLeaf,
  SeasonInfo,
  SeasonPayout,
  SeasonStanding,
  SeasonStatus,
  Standings,
  VerifiedRecord,
  VerifyCheck,
} from './types';

/**
 * The low-level verification primitives, straight from `@probatio/commit`, for
 * callers who already hold the data and want to check hashes themselves.
 */
export {
  EMPTY_ACCUMULATOR,
  buildProof,
  buildTree,
  computeRoot,
  extendChain,
  fromHex,
  hashLeaf,
  replayChain,
  toHex,
  verifyProof,
  verifyTrade,
} from '@probatio/commit';
