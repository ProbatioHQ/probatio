/**
 * @probatio/validation — the gate.
 *
 * Replays real historical swaps through the fill engine and measures how
 * closely it reproduces them. Every claim this project makes reduces to this
 * number, and it is meant to be run by anyone, not taken on trust.
 */

export { collectEvents } from './collect';
export type { CollectOptions } from './collect';

export { combine, isConsecutive, replay } from './replay';
export type { OrderedEvent, Sample, SkipReason, ValidationReport } from './replay';

export { formatReport } from './format';

export { DEFAULT_THRESHOLDS, assessDrift, assessToken } from './drift';
export type { DriftAssessment, DriftSeverity, DriftThresholds, TokenDrift } from './drift';
