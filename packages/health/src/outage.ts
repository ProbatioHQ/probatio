/**
 * How long something was down.
 *
 * This exists because of the void policy. A season is void if the price feed
 * was unavailable for more than two hours, and a threshold nobody measures is
 * a sentence in a document rather than a rule. Writing the policy without
 * building this would have been the more comfortable order and the wrong one.
 *
 * Outages are stored as intervals, not as a log of probes. A probe every ten
 * seconds for a week is sixty thousand rows that answer one question badly;
 * an interval answers it exactly and costs two rows per incident.
 */

export type Dependency = 'rpc' | 'database' | 'feed' | 'coach';

export interface Outage {
  readonly dependency: Dependency;
  readonly startedAt: number;
  /** Null while it is still going on. */
  readonly endedAt: number | null;
  readonly detail: string | null;
}

/**
 * Milliseconds a dependency was down within a window.
 *
 * Overlapping outages are merged rather than summed. Two probes disagreeing,
 * or an outage recorded twice by two instances, would otherwise report more
 * downtime than the wall clock contains — and that number decides whether a
 * season is void.
 */
export function outageMs(
  outages: readonly Outage[],
  from: number,
  to: number,
  now: number,
): number {
  if (to <= from) return 0;

  const windows = outages
    .map((outage) => ({
      // An outage still open counts up to the present, not forever.
      start: Math.max(outage.startedAt, from),
      end: Math.min(outage.endedAt ?? now, to),
    }))
    .filter((window) => window.end > window.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursor: { start: number; end: number } | null = null;

  for (const window of windows) {
    if (cursor === null) {
      cursor = { ...window };
      continue;
    }
    if (window.start <= cursor.end) {
      cursor.end = Math.max(cursor.end, window.end);
    } else {
      total += cursor.end - cursor.start;
      cursor = { ...window };
    }
  }
  if (cursor) total += cursor.end - cursor.start;

  return total;
}

export function outageMinutes(
  outages: readonly Outage[],
  from: number,
  to: number,
  now: number,
): number {
  // Rounded up. Reporting 119 minutes of a 119.6 minute outage against a 120
  // minute threshold decides a season on a rounding choice.
  return Math.ceil(outageMs(outages, from, to, now) / 60_000);
}

export function currentlyDown(outages: readonly Outage[]): Dependency[] {
  return [...new Set(outages.filter((o) => o.endedAt === null).map((o) => o.dependency))];
}
