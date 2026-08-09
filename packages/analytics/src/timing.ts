import type { RoundTrip } from './roundtrips';
import { BPS } from './metrics';

/**
 * When the trader trades, and whether it matters.
 *
 * Bucketed in UTC and labelled as such. A local-time bucket would be wrong for
 * everyone but the person whose machine produced it, and this data is read on a
 * server and shown to someone who could be anywhere.
 */

export interface Bucket {
  /** 0–23 for hours, 0–6 for days with 0 = Sunday. */
  readonly index: number;
  readonly trips: number;
  readonly wins: number;
  readonly realized: bigint;
  /** Null when the bucket is empty. */
  readonly winRateBps: number | null;
}

export interface TimeOfDay {
  readonly hours: readonly Bucket[];
  readonly daysOfWeek: readonly Bucket[];
  /** The hour with the most profit, among hours with at least `minTrips`. */
  readonly bestHour: Bucket | null;
  readonly worstHour: Bucket | null;
  /** How many trips an hour needed before it could be called best or worst. */
  readonly minTrips: number;
}

function empty(size: number): { index: number; trips: number; wins: number; realized: bigint }[] {
  return Array.from({ length: size }, (_, index) => ({
    index,
    trips: 0,
    wins: 0,
    realized: 0n,
  }));
}

/**
 * @param minTrips Hours below this are excluded from best and worst. One
 *   lucky trade at 4am is not a talent, and naming it as one would send
 *   somebody to trade at 4am.
 */
export function computeTimeOfDay(trips: readonly RoundTrip[], minTrips = 3): TimeOfDay {
  const hours = empty(24);
  const days = empty(7);

  for (const trip of trips) {
    // Bucketed by when the position was opened — the decision being measured
    // is when the trader chose to act, not when the exit happened to fall.
    const opened = new Date(trip.openedAt);
    for (const bucket of [hours[opened.getUTCHours()]!, days[opened.getUTCDay()]!]) {
      bucket.trips += 1;
      bucket.realized += trip.realized;
      if (trip.realized > 0n) bucket.wins += 1;
    }
  }

  const finish = (bucket: (typeof hours)[number]): Bucket => ({
    ...bucket,
    winRateBps: bucket.trips === 0 ? null : Math.round((bucket.wins * Number(BPS)) / bucket.trips),
  });

  const hourBuckets = hours.map(finish);
  const eligible = hourBuckets.filter((bucket) => bucket.trips >= minTrips);

  const best = eligible.reduce<Bucket | null>(
    (winner, bucket) => (winner === null || bucket.realized > winner.realized ? bucket : winner),
    null,
  );
  const worst = eligible.reduce<Bucket | null>(
    (loser, bucket) => (loser === null || bucket.realized < loser.realized ? bucket : loser),
    null,
  );

  return {
    hours: hourBuckets,
    daysOfWeek: days.map(finish),
    bestHour: best,
    worstHour: worst,
    minTrips,
  };
}
