import type { RoundTrip } from './roundtrips';
import { BPS } from './metrics';

/**
 * The worst stretch.
 *
 * Measured on realized equity — the balance after each round trip closes — not
 * on a mark-to-market curve. That is a real limitation and it is stated rather
 * than hidden: while a position is open its value moves, and a trader who was
 * down further mid-trade than this number admits is not being flattered by a
 * bug, they are reading a number about closed results.
 *
 * Marking open positions would need a price for every token at every moment of
 * every hold, which is a different and far more expensive question.
 */

export interface EquityPoint {
  readonly at: number;
  /** Balance after this trip closed. */
  readonly equity: bigint;
  /** The highest equity reached up to and including this point. */
  readonly peak: bigint;
}

export interface Drawdown {
  readonly curve: readonly EquityPoint[];
  /** Largest peak-to-trough fall, as a positive number. Zero if never down. */
  readonly maxDrawdown: bigint;
  /** That fall as bps of the peak it fell from. Null if the peak was zero. */
  readonly maxDrawdownBps: number | null;
  /** When the trough was reached. Null if there was never a drawdown. */
  readonly troughAt: number | null;
  /** Longest run of consecutive losing trips. */
  readonly longestLosingStreak: number;
  readonly longestWinningStreak: number;
}

export function computeDrawdown(
  trips: readonly RoundTrip[],
  startingBalance: bigint,
): Drawdown {
  const ordered = [...trips].sort((a, b) => a.closedAt - b.closedAt);

  const curve: EquityPoint[] = [];
  let equity = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0n;
  let peakAtTrough = startingBalance;
  let troughAt: number | null = null;

  let losing = 0;
  let winning = 0;
  let longestLosing = 0;
  let longestWinning = 0;

  for (const trip of ordered) {
    equity += trip.realized;
    if (equity > peak) peak = equity;

    const fall = peak - equity;
    if (fall > maxDrawdown) {
      maxDrawdown = fall;
      peakAtTrough = peak;
      troughAt = trip.closedAt;
    }

    curve.push({ at: trip.closedAt, equity, peak });

    if (trip.realized < 0n) {
      losing += 1;
      winning = 0;
      if (losing > longestLosing) longestLosing = losing;
    } else if (trip.realized > 0n) {
      winning += 1;
      losing = 0;
      if (winning > longestWinning) longestWinning = winning;
    } else {
      // A scratch breaks neither streak's story, but it does end the run.
      losing = 0;
      winning = 0;
    }
  }

  return {
    curve,
    maxDrawdown,
    maxDrawdownBps:
      maxDrawdown === 0n || peakAtTrough === 0n
        ? maxDrawdown === 0n
          ? 0
          : null
        : Number((maxDrawdown * BPS) / peakAtTrough),
    troughAt,
    longestLosingStreak: longestLosing,
    longestWinningStreak: longestWinning,
  };
}
