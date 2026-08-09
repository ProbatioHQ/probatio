import type { RoundTrip } from './roundtrips';

/**
 * What the round trips say about the trader.
 *
 * Integer arithmetic throughout, with ratios in basis points, because these
 * numbers end up on a public profile beside an on-chain hash and a float that
 * renders as 0.30000000000000004 makes the whole page look made up.
 *
 * Every ratio here is null rather than zero when it has no denominator. A
 * trader with no losing trades has an undefined profit factor, and reporting
 * that as 0 would rank them below everyone.
 */

export const BPS = 10_000n;

export interface Distribution {
  readonly count: number;
  readonly total: bigint;
  /** Floored. */
  readonly average: bigint | null;
  readonly median: bigint | null;
  readonly largest: bigint | null;
  readonly smallest: bigint | null;
}

export interface Metrics {
  readonly trips: number;
  readonly wins: number;
  readonly losses: number;
  /** Exactly break-even trips. Counted separately so they cannot flatter a win rate. */
  readonly scratches: number;
  /** Basis points of closed trips that made money. Null with no closed trips. */
  readonly winRateBps: number | null;

  readonly grossProfit: bigint;
  readonly grossLoss: bigint;
  readonly netPnl: bigint;
  readonly feesPaid: bigint;

  /** `grossProfit / grossLoss` in bps. Null when nothing was lost. */
  readonly profitFactorBps: number | null;
  /** Average win over average loss, in bps. Null without one of each. */
  readonly winLossMultipleBps: number | null;
  /** Average outcome per trip, floored toward zero. Null with no trips. */
  readonly expectancy: bigint | null;

  readonly winSizes: Distribution;
  readonly lossSizes: Distribution;
  readonly positionSizes: Distribution;

  /** Milliseconds. */
  readonly holdMs: NumberDistribution;
  readonly winnerHoldMs: NumberDistribution;
  readonly loserHoldMs: NumberDistribution;

  /**
   * Average distance from the average position size, over the average size, in
   * bps. Zero means every trade was the same size. Null with fewer than two.
   */
  readonly sizeConsistencyBps: number | null;
}

export interface NumberDistribution {
  readonly count: number;
  readonly average: number | null;
  readonly median: number | null;
  readonly longest: number | null;
  readonly shortest: number | null;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Divide and round toward zero.
 *
 * bigint division already truncates, which for a signed average means an
 * average loss of -1.5 reports as -1. Rounding toward zero rather than down
 * keeps a loss from being overstated purely by the sign of the numerator.
 */
function divTowardZero(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator;
}

function ratioBps(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  return Number((numerator * BPS) / denominator);
}

function medianBigint(sorted: readonly bigint[]): bigint | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return divTowardZero(sorted[middle - 1]! + sorted[middle]!, 2n);
}

function distribution(values: readonly bigint[]): Distribution {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = values.reduce((sum, value) => sum + value, 0n);
  return {
    count: values.length,
    total,
    average: values.length === 0 ? null : divTowardZero(total, BigInt(values.length)),
    median: medianBigint(sorted),
    largest: sorted.at(-1) ?? null,
    smallest: sorted[0] ?? null,
  };
}

function numberDistribution(values: readonly number[]): NumberDistribution {
  if (values.length === 0) {
    return { count: 0, average: null, median: null, longest: null, shortest: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: values.length,
    average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median:
      sorted.length % 2 === 1
        ? sorted[middle]!
        : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2),
    longest: sorted.at(-1)!,
    shortest: sorted[0]!,
  };
}

/**
 * How evenly sized the positions were.
 *
 * Mean absolute deviation rather than standard deviation: there is no integer
 * square root to take, and squaring lets one outsized bet dominate a number
 * that is supposed to describe the habit rather than the exception.
 */
function sizeConsistency(sizes: readonly bigint[]): number | null {
  if (sizes.length < 2) return null;
  const count = BigInt(sizes.length);
  const mean = sizes.reduce((sum, size) => sum + size, 0n) / count;
  if (mean === 0n) return null;
  const deviation = sizes.reduce((sum, size) => sum + abs(size - mean), 0n) / count;
  return Number((deviation * BPS) / mean);
}

export function computeMetrics(trips: readonly RoundTrip[]): Metrics {
  const winners = trips.filter((trip) => trip.realized > 0n);
  const losers = trips.filter((trip) => trip.realized < 0n);
  const scratches = trips.length - winners.length - losers.length;

  const grossProfit = winners.reduce((sum, trip) => sum + trip.realized, 0n);
  const grossLoss = losers.reduce((sum, trip) => sum + abs(trip.realized), 0n);
  const netPnl = grossProfit - grossLoss;

  const winSizes = distribution(winners.map((trip) => trip.realized));
  const lossSizes = distribution(losers.map((trip) => abs(trip.realized)));
  const positionSizes = distribution(trips.map((trip) => trip.invested));

  return {
    trips: trips.length,
    wins: winners.length,
    losses: losers.length,
    scratches,
    winRateBps:
      trips.length === 0 ? null : Math.round((winners.length * Number(BPS)) / trips.length),

    grossProfit,
    grossLoss,
    netPnl,
    feesPaid: trips.reduce((sum, trip) => sum + trip.feesPaid, 0n),

    profitFactorBps: ratioBps(grossProfit, grossLoss),
    winLossMultipleBps:
      winSizes.average === null || lossSizes.average === null || lossSizes.average === 0n
        ? null
        : ratioBps(winSizes.average, lossSizes.average),
    expectancy: trips.length === 0 ? null : divTowardZero(netPnl, BigInt(trips.length)),

    winSizes,
    lossSizes,
    positionSizes,

    holdMs: numberDistribution(trips.map((trip) => trip.heldMs)),
    winnerHoldMs: numberDistribution(winners.map((trip) => trip.heldMs)),
    loserHoldMs: numberDistribution(losers.map((trip) => trip.heldMs)),

    sizeConsistencyBps: sizeConsistency(trips.map((trip) => trip.invested)),
  };
}
