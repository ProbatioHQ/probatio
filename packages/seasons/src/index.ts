/**
 * @probatio/seasons — the rules of a season, and what they cost.
 *
 * Pure. A season's ruleset is hashed and that hash goes on chain before anybody
 * enters, so the rules can be read, rehashed by a stranger, and checked against
 * what the program recorded. Rules that could be adjusted after a result are
 * not rules.
 */

export {
  RULESET_BYTES,
  RulesetError,
  encodeRuleset,
  rulesetHash,
  rulesetHashHex,
  validateRuleset,
} from './ruleset';
export type { PayoutBand, Ruleset, ScoringRule, Tiebreak } from './ruleset';

export {
  ENGINE_VERSION,
  ENTRY_COST,
  ENTRY_WINDOW_MS,
  HOUSE_BPS,
  HOUSE_THRESHOLD,
  LAMPORTS_PER_SOL,
  LATENCY_MS,
  MAX_PRICE_IMPACT_BPS,
  PAYOUT_BANDS,
  SEASON_DURATION_MS,
  SEASON_ONE_DURATION_MS,
  SLIPPAGE_BPS,
  STARTING_BALANCE,
  rulesetFor,
} from './spec';

export { bandFor, distribute, houseCut, nextBand } from './payout';
export type { Distribution, Payout } from './payout';

export {
  entryOpen,
  scheduleFrom,
  statusAt,
  timeUntilEntryCloses,
  tradingOpen,
} from './lifecycle';
export type { Schedule, SeasonStatus, SeasonTiming } from './lifecycle';
