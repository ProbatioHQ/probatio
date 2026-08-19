/**
 * @probatio/sdk
 *
 * Read a Probatio trading record, and check it yourself.
 *
 * The point of Probatio is that a record does not need Probatio to be believed.
 * This is that in a library: it fetches a trader's fills together with the seal
 * written over each one at the moment it was priced, recomputes those seals from
 * the figures, and folds the fills into a tree whose root it rebuilds. A
 * `verified: true` is the result of arithmetic you ran, never a server's
 * say-so, and the same code the engine seals with is the code checking it.
 *
 * Alter any field of a stored fill afterwards, to improve a price or shave a
 * fee, and the hash recomputed from it stops matching the seal beside it. The
 * server cannot make that come out right without forging the seal, and it
 * cannot forge the seal without the figures that produce it, which are the
 * figures it just handed you.
 *
 * Nothing here reads a chain or needs an RPC. Every check is local and
 * synchronous once the data is in hand.
 */

export { Probatio } from './client';
export type { ProbatioConfig } from './client';

export { verifyRecord, verifyBundle } from './verify';
export type { VerifyOptions } from './verify';

export { ProbatioError, getProof, getRecord, getSeason, getStandings } from './read';
export type { ReadOptions } from './read';

export { DEFAULT_API_BASE } from './constants';

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
