/**
 * Where a season is in its life.
 *
 * Derived from its own timestamps rather than stored and updated, so a status
 * cannot be left behind by a process that failed halfway through. There is no
 * job whose failure freezes a season in the wrong state, because there is no
 * job — the answer is a function of the clock.
 *
 * `finalized` is the exception and is genuinely stored: it means a results root
 * was written on chain, which is an event, not a time.
 */

export type SeasonStatus = 'pending' | 'entry_open' | 'running' | 'closed' | 'finalized';

export interface SeasonTiming {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly entryClosesAt: number;
  /** Set once a results root is on chain. */
  readonly finalizedAt: number | null;
}

export function statusAt(timing: SeasonTiming, now: number): SeasonStatus {
  if (timing.finalizedAt !== null) return 'finalized';
  if (now < timing.startsAt) return 'pending';
  if (now >= timing.endsAt) return 'closed';
  return now < timing.entryClosesAt ? 'entry_open' : 'running';
}

/** Whether somebody can still pay to enter. */
export function entryOpen(timing: SeasonTiming, now: number): boolean {
  return statusAt(timing, now) === 'entry_open';
}

/** Whether trades still count toward this season. */
export function tradingOpen(timing: SeasonTiming, now: number): boolean {
  const status = statusAt(timing, now);
  return status === 'entry_open' || status === 'running';
}

export interface Schedule {
  readonly startsAt: number;
  readonly endsAt: number;
  readonly entryClosesAt: number;
}

/**
 * When a season runs.
 *
 * Seasons are back to back with no gap, so the next one starts exactly when the
 * last one ends. A gap would be a stretch where a ranked trade counts toward
 * nothing, which is worse than it sounds: it is the one period where the record
 * a trader is building quietly stops being built.
 */
export function scheduleFrom(startsAt: number, durationMs: number, entryWindowMs: number): Schedule {
  return {
    startsAt,
    endsAt: startsAt + durationMs,
    entryClosesAt: startsAt + Math.min(entryWindowMs, durationMs),
  };
}

/** Milliseconds until the entry window shuts, or null once it has. */
export function timeUntilEntryCloses(timing: SeasonTiming, now: number): number | null {
  if (!entryOpen(timing, now)) return null;
  return timing.entryClosesAt - now;
}
