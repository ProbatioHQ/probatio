/**
 * @probatio/sim — the fill engine.
 *
 * This package is deliberately sealed off from the rest of the system. It has
 * no network access, no database, no clock and no filesystem. Everything it
 * exports is a pure function of its arguments.
 *
 * That isolation is not tidiness. Step 11 replays thousands of real historical
 * swaps through this package and compares the output against what actually
 * happened on chain, and that comparison is only meaningful if the engine
 * cannot reach anything the replay does not control.
 */

export { ENGINE_VERSION, ENGINE_VERSION_LOG } from './version';

export {
  BPS_DENOMINATOR,
  FixedPointError,
  feeOf,
  formatAmount,
  mulDivCeil,
  mulDivFloor,
  parseAmount,
  subtractFee,
} from './fixed';
export type { Amount } from './fixed';

export { totalFeeBps } from './types';
export type { FeeSchedule, PoolSource, PoolState, Side } from './types';

export { QuoteError, applyQuote, quoteBuy, quoteSell } from './engine';
export type { Quote, QuoteErrorCode } from './engine';

export { backtestCopy } from './copy';
export type { CopyInput, CopyLeg, CopyOptions, CopyResult } from './copy';
export { backtestRule } from './backtest';
export type {
  BacktestLeg,
  BacktestOptions,
  BacktestResult,
  ExitReason,
  ReplayPoint,
  Rule,
} from './backtest';
export {
  DAILY_TRADE_CAP,
  MAX_OPEN_POSITIONS,
  MAX_STAKE_LAMPORTS,
  MIN_STAKE_LAMPORTS,
  RULES_VERSION,
  StrategyRulesError,
  exitDecision,
  matchesEntry,
  parseStrategyRules,
  readStoredRules,
  serializeStrategyRules,
} from './strategy';
export type {
  Candidate,
  EntryRules,
  EntryVerdict,
  ExitRules,
  ExitTrigger,
  SizeRules,
  StrategyRules,
  Venue,
} from './strategy';

export { DEFAULT_RULES, simulateFill } from './execution';
export type {
  ExecutionRules,
  FillOutcome,
  FillRequest,
  FilledOutcome,
  RejectReason,
  RejectedOutcome,
} from './execution';
