/**
 * @probatio/coach — turning a trader's own numbers into advice.
 *
 * The model supplies judgement. Every figure comes from the analytics engine,
 * and anything the model writes that contains a number not in the record is
 * dropped before a trader ever sees it. On a product whose argument is that its
 * numbers can be checked against a chain, a fabricated statistic in a coaching
 * report is the same failure as a fabricated leaderboard entry — only harder to
 * notice.
 */

export {
  MINIMUM_TRIPS,
  buildBrief,
  formatBps,
  formatDuration,
  formatSol,
} from './brief';
export type { Brief, BriefInput, Fact, FactKey } from './brief';

export {
  SYSTEM_PROMPT,
  buildUserMessage,
  insufficientHistoryMessage,
} from './prompt';

export { reviewResponse, unsupportedFigures } from './review';
export type { Observation, Report, ReviewResult } from './review';

export {
  RANKED_COOLDOWN_MS,
  WEEK_MS,
  cooldownFor,
  entitlement,
  explainRefusal,
} from './entitlement';
export type { Entitlement, EntitlementInput, Refusal, Tier } from './entitlement';

export { CoachError, DEFAULT_MODEL, requestReport } from './client';
export type { CoachOptions, CoachResponse } from './client';
