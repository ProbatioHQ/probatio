import { PRICE_SCALE, type ScaledPrice } from '@probatio/candles';
import { BPS } from './metrics';
import type { RoundTrip } from './roundtrips';

/**
 * Entry and exit quality, against what the market actually offered.
 *
 * Everything else here can be computed from the trade log alone. These two
 * cannot: "you sold too early" is meaningless without knowing what the price
 * did afterwards, so the caller supplies the high and low over the hold.
 *
 * That keeps this pure. The price window comes from the same candles the chart
 * is drawn from, so a trader can look at the number and then look at the chart
 * and see the same thing.
 */

/** The extremes over a position's life. */
export interface PriceWindow {
  readonly high: ScaledPrice;
  readonly low: ScaledPrice;
}

export interface Excursion {
  readonly mint: string;
  readonly openedAt: number;
  readonly closedAt: number;

  /** Average price paid, fees included. */
  readonly averageEntry: ScaledPrice;
  /** Average price received, after fees. */
  readonly averageExit: ScaledPrice;
  /** What the trip actually returned, in bps of what went in. */
  readonly returnBps: number;

  /** Best unrealized gain available, in bps of the entry. Never negative. */
  readonly mfeBps: number;
  /** Worst unrealized loss endured, in bps of the entry. Never negative. */
  readonly maeBps: number;

  /**
   * How close the entry was to the low of the range: 10000 is the exact low,
   * 0 the exact high. Null when the range has no width.
   */
  readonly entryEfficiencyBps: number | null;
  /** How close the exit was to the high, on the same scale. */
  readonly exitEfficiencyBps: number | null;
}

function clampBps(value: bigint): number {
  if (value < 0n) return 0;
  if (value > BPS) return Number(BPS);
  return Number(value);
}

/**
 * The average price across a side of the trip.
 *
 * Fees are inside these numbers, because they were inside the trader's result.
 * It makes both entries look slightly worse and both exits slightly worse than
 * the chart, which is correct: nobody trades at the mid.
 */
function averagePrice(sol: bigint, tokens: bigint): ScaledPrice {
  return tokens === 0n ? 0n : (sol * PRICE_SCALE) / tokens;
}

export function computeExcursion(trip: RoundTrip, window: PriceWindow): Excursion {
  const averageEntry = averagePrice(trip.invested, trip.tokensBought);
  const averageExit = averagePrice(trip.proceeds, trip.tokensSold);

  const returnBps =
    trip.invested === 0n ? 0 : Number((trip.realized * BPS) / trip.invested);

  const mfe = window.high > averageEntry ? window.high - averageEntry : 0n;
  const mae = window.low < averageEntry ? averageEntry - window.low : 0n;

  const range = window.high - window.low;

  return {
    mint: trip.mint,
    openedAt: trip.openedAt,
    closedAt: trip.closedAt,
    averageEntry,
    averageExit,
    returnBps,
    mfeBps: averageEntry === 0n ? 0 : Number((mfe * BPS) / averageEntry),
    maeBps: averageEntry === 0n ? 0 : Number((mae * BPS) / averageEntry),
    // Clamped, because an average price that includes fees can sit outside a
    // range taken from mid-prices. Reporting "111% efficient" would be a
    // rounding artefact dressed up as a compliment.
    entryEfficiencyBps: range <= 0n ? null : clampBps(((window.high - averageEntry) * BPS) / range),
    exitEfficiencyBps: range <= 0n ? null : clampBps(((averageExit - window.low) * BPS) / range),
  };
}

export interface ExcursionSummary {
  readonly count: number;
  /** Averages over every trip that had a usable price range. Null if none did. */
  readonly averageEntryEfficiencyBps: number | null;
  readonly averageExitEfficiencyBps: number | null;
  readonly averageMfeBps: number | null;
  readonly averageMaeBps: number | null;
  /**
   * Trips that were up more than this much and still closed at a loss. The
   * single most useful thing this whole module produces: it is the difference
   * between being wrong and refusing to be right.
   */
  readonly gaveBackWinners: number;
  readonly gaveBackThresholdBps: number;
}

export function summarizeExcursions(
  excursions: readonly Excursion[],
  gaveBackThresholdBps = 2_000,
): ExcursionSummary {
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  const withRange = excursions.filter((item) => item.entryEfficiencyBps !== null);

  return {
    count: excursions.length,
    averageEntryEfficiencyBps: mean(withRange.map((item) => item.entryEfficiencyBps!)),
    averageExitEfficiencyBps: mean(withRange.map((item) => item.exitEfficiencyBps!)),
    averageMfeBps: mean(excursions.map((item) => item.mfeBps)),
    averageMaeBps: mean(excursions.map((item) => item.maeBps)),
    gaveBackWinners: excursions.filter(
      (item) => item.mfeBps >= gaveBackThresholdBps && item.returnBps < 0,
    ).length,
    gaveBackThresholdBps,
  };
}
