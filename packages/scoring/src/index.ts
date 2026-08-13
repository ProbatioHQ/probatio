/**
 * @probatio/scoring — who won, and the proof of it.
 *
 * Pure. Ranking is a published, runnable rule rather than an assertion: anybody
 * holding the same standings can sort them with `compareStandings` and get the
 * same order. The final standings are committed as a merkle root, so a trader
 * can prove their own place and payout without anyone publishing the rest.
 */

export { compareStandings, placeOf, rankSeason, returnBps } from './rank';
export type { RankedStanding, Standing } from './rank';

export {
  EMPTY_SEASON_ROOT,
  RESULT_LEAF_BYTES,
  RESULT_LEAF_PREFIX,
  ResultError,
  encodeResultLeaf,
  hashResultLeaf,
  resultLeaves,
  resultsRoot,
  resultsRootHex,
  VOID_SEASON_ROOT,
} from './results';
export type { ResultLeaf } from './results';

export { FinalizeError, buildFinalization, verifyFinalization } from './finalize';
export type {
  Entrant,
  Finalization,
  FinalizationInput,
  FinalizedRow,
  PlacePayout,
  VerifyResult,
} from './finalize';
