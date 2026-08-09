import type { Amount } from '@probatio/sim';
import type { ScaledPrice } from './price';

/**
 * Aggregating price observations into candles.
 *
 * Pure functions over a list of observations. No clock, no network, no
 * database — a candle is entirely determined by the trades inside it, which is
 * what lets the same code build history from chain and keep the live chart
 * moving without the two ever disagreeing.
 */

/** Supported bucket sizes, in seconds. Memecoins need the short end. */
export const TIMEFRAMES = {
  s1: 1,
  s5: 5,
  s15: 15,
  m1: 60,
  m5: 300,
  m15: 900,
  h1: 3600,
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;

export function timeframeSeconds(timeframe: Timeframe): number {
  return TIMEFRAMES[timeframe];
}

/** A single trade, reduced to what a chart needs. */
export interface Observation {
  /** Unix seconds. */
  readonly timestamp: number;
  readonly price: ScaledPrice;
  /** SOL moved, in lamports. Zero is allowed; a price can be observed without a trade. */
  readonly volumeLamports: Amount;
}

export interface Candle {
  /** Unix seconds of the bucket's start. Always a multiple of the timeframe. */
  readonly openTime: number;
  readonly open: ScaledPrice;
  readonly high: ScaledPrice;
  readonly low: ScaledPrice;
  readonly close: ScaledPrice;
  readonly volumeLamports: Amount;
  readonly trades: number;
}

export class CandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleError';
  }
}

/** The start of the bucket a timestamp falls in. */
export function bucketStart(timestamp: number, timeframe: Timeframe): number {
  const size = timeframeSeconds(timeframe);
  return Math.floor(timestamp / size) * size;
}

/**
 * Build candles from observations.
 *
 * Observations may arrive in any order — chain history comes back newest first
 * — so they are sorted rather than assumed. Ties are broken by input order,
 * which keeps the result stable when several trades share a second, as they
 * routinely do.
 */
export function buildCandles(
  observations: readonly Observation[],
  timeframe: Timeframe,
): Candle[] {
  if (observations.length === 0) return [];

  const ordered = observations
    .map((observation, index) => ({ observation, index }))
    .sort((a, b) =>
      a.observation.timestamp === b.observation.timestamp
        ? a.index - b.index
        : a.observation.timestamp - b.observation.timestamp,
    )
    .map((entry) => entry.observation);

  const candles: Candle[] = [];
  let current: {
    openTime: number;
    open: ScaledPrice;
    high: ScaledPrice;
    low: ScaledPrice;
    close: ScaledPrice;
    volumeLamports: Amount;
    trades: number;
  } | null = null;

  for (const observation of ordered) {
    if (observation.price <= 0n) {
      throw new CandleError(`observation at ${observation.timestamp} has a non-positive price`);
    }

    const openTime = bucketStart(observation.timestamp, timeframe);

    if (!current || current.openTime !== openTime) {
      if (current) candles.push({ ...current });
      current = {
        openTime,
        open: observation.price,
        high: observation.price,
        low: observation.price,
        close: observation.price,
        volumeLamports: observation.volumeLamports,
        trades: 1,
      };
      continue;
    }

    if (observation.price > current.high) current.high = observation.price;
    if (observation.price < current.low) current.low = observation.price;
    current.close = observation.price;
    current.volumeLamports += observation.volumeLamports;
    current.trades += 1;
  }

  if (current) candles.push({ ...current });
  return candles;
}

/**
 * Fill the gaps between candles.
 *
 * A token that goes untraded for ten minutes leaves a hole, and a chart drawn
 * straight from the sparse series shows a price that appears to teleport. Each
 * gap becomes a flat candle at the previous close with no volume, which is what
 * actually happened: the price did not move because nobody traded.
 *
 * Bounded so a token with one trade last week and one today cannot generate
 * hundreds of thousands of empty candles.
 */
export function fillGaps(
  candles: readonly Candle[],
  timeframe: Timeframe,
  maxCandles = 10_000,
): Candle[] {
  if (candles.length < 2) return [...candles];

  const size = timeframeSeconds(timeframe);
  const filled: Candle[] = [];

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]!;
    filled.push(candle);

    const next = candles[i + 1];
    if (!next) break;

    for (
      let time = candle.openTime + size;
      time < next.openTime && filled.length < maxCandles;
      time += size
    ) {
      filled.push({
        openTime: time,
        open: candle.close,
        high: candle.close,
        low: candle.close,
        close: candle.close,
        volumeLamports: 0n,
        trades: 0,
      });
    }

    if (filled.length >= maxCandles) break;
  }

  return filled;
}

/**
 * Merge newly observed candles into stored ones.
 *
 * The last stored candle is usually still open — more trades will land in the
 * same bucket — so an overlapping bucket is combined rather than replaced. The
 * open is kept from whichever came first and the close from whichever came
 * last, which is the only merge that stays correct when a backfill and the live
 * feed touch the same bucket.
 */
export function mergeCandles(stored: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of stored) byTime.set(candle.openTime, candle);

  for (const candle of incoming) {
    const existing = byTime.get(candle.openTime);
    if (!existing) {
      byTime.set(candle.openTime, candle);
      continue;
    }

    byTime.set(candle.openTime, {
      openTime: candle.openTime,
      open: existing.open,
      high: existing.high > candle.high ? existing.high : candle.high,
      low: existing.low < candle.low ? existing.low : candle.low,
      close: candle.close,
      volumeLamports: existing.volumeLamports + candle.volumeLamports,
      trades: existing.trades + candle.trades,
    });
  }

  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}
