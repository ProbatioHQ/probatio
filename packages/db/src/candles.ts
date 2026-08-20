import type { Client } from '@libsql/client';

/**
 * Candle storage.
 *
 * Mirrors the merge semantics of `mergeCandles` in @probatio/candles, in SQL:
 * an incoming candle for a bucket that already exists keeps the stored open,
 * takes the new close, widens the high and low, and adds to the volume.
 *
 * That has to happen in the database rather than in a read-modify-write, or two
 * writers touching the same open bucket would each overwrite the other's
 * trades.
 */

export interface StoredCandle {
  readonly openTime: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly trades: number;
}

export interface CandleWrite {
  readonly openTime: number;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volumeLamports: bigint;
  readonly trades: number;
}

function toStored(row: Record<string, unknown>): StoredCandle {
  return {
    openTime: Number(row['open_time']),
    open: String(row['open']),
    high: String(row['high']),
    low: String(row['low']),
    close: String(row['close']),
    volume: String(row['volume']),
    trades: Number(row['trades']),
  };
}

/**
 * Write candles, merging into any bucket that already exists.
 *
 * The high and low comparisons are done on the integer value rather than the
 * stored string, because '9' sorts above '10' as text and a lexicographic
 * comparison would pick the wrong extreme.
 */
export async function writeCandles(
  db: Client,
  mint: string,
  timeframe: string,
  candles: readonly CandleWrite[],
): Promise<void> {
  if (candles.length === 0) return;

  await db.batch(
    candles.map((candle) => ({
      sql: `INSERT INTO candles (mint, timeframe, open_time, open, high, low, close, volume, trades)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mint, timeframe, open_time) DO UPDATE SET
              high   = CASE WHEN CAST(excluded.high AS INTEGER) > CAST(candles.high AS INTEGER)
                            THEN excluded.high ELSE candles.high END,
              low    = CASE WHEN CAST(excluded.low AS INTEGER) < CAST(candles.low AS INTEGER)
                            THEN excluded.low ELSE candles.low END,
              close  = excluded.close,
              volume = CAST(CAST(candles.volume AS INTEGER) + CAST(excluded.volume AS INTEGER) AS TEXT),
              trades = candles.trades + excluded.trades`,
      args: [
        mint,
        timeframe,
        candle.openTime,
        candle.open.toString(),
        candle.high.toString(),
        candle.low.toString(),
        candle.close.toString(),
        candle.volumeLamports.toString(),
        candle.trades,
      ],
    })),
    'write',
  );
}

/** The most recent candles for a mint, oldest first. */
export async function readCandles(
  db: Client,
  mint: string,
  timeframe: string,
  limit = 500,
): Promise<StoredCandle[]> {
  const result = await db.execute({
    sql: `SELECT * FROM (
            SELECT * FROM candles
            WHERE mint = ? AND timeframe = ?
            ORDER BY open_time DESC
            LIMIT ?
          ) ORDER BY open_time ASC`,
    args: [mint, timeframe, limit],
  });
  return result.rows.map((row) => toStored(row as unknown as Record<string, unknown>));
}

/**
 * Combine finer candles into coarser ones.
 *
 * The short timeframes are stored; the long ones, four hours and up, are built
 * from the hourly candle on read rather than written on every poll — five more
 * writes per token per tick, for buckets that barely move, is a cost the write
 * path does not need to carry. Input must be oldest-first, the way `readCandles`
 * returns it, so a bucket's open is its first candle and its close its last.
 */
export function rollupCandles(
  candles: readonly StoredCandle[],
  targetSeconds: number,
): StoredCandle[] {
  const buckets = new Map<
    number,
    { openTime: number; open: string; high: bigint; low: bigint; close: string; volume: bigint; trades: number }
  >();

  for (const candle of candles) {
    const start = Math.floor(candle.openTime / targetSeconds) * targetSeconds;
    const high = BigInt(candle.high);
    const low = BigInt(candle.low);
    const volume = BigInt(candle.volume);

    const existing = buckets.get(start);
    if (!existing) {
      buckets.set(start, {
        openTime: start,
        open: candle.open,
        high,
        low,
        close: candle.close,
        volume,
        trades: candle.trades,
      });
      continue;
    }

    if (high > existing.high) existing.high = high;
    if (low < existing.low) existing.low = low;
    existing.close = candle.close;
    existing.volume += volume;
    existing.trades += candle.trades;
  }

  return [...buckets.values()]
    .sort((a, b) => a.openTime - b.openTime)
    .map((bucket) => ({
      openTime: bucket.openTime,
      open: bucket.open,
      high: bucket.high.toString(),
      low: bucket.low.toString(),
      close: bucket.close,
      volume: bucket.volume.toString(),
      trades: bucket.trades,
    }));
}

export interface BackfillRecord {
  readonly mint: string;
  readonly oldestTimestamp: number | null;
  readonly newestTimestamp: number | null;
  readonly observations: number;
  readonly truncated: boolean;
  readonly completedAt: number;
}

export async function recordBackfill(
  db: Client,
  record: Omit<BackfillRecord, 'completedAt'>,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO candle_backfills
            (mint, oldest_timestamp, newest_timestamp, observations, truncated, completed_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (mint) DO UPDATE SET
            oldest_timestamp = MIN(
              COALESCE(candle_backfills.oldest_timestamp, excluded.oldest_timestamp),
              COALESCE(excluded.oldest_timestamp, candle_backfills.oldest_timestamp)
            ),
            newest_timestamp = MAX(
              COALESCE(candle_backfills.newest_timestamp, excluded.newest_timestamp),
              COALESCE(excluded.newest_timestamp, candle_backfills.newest_timestamp)
            ),
            observations = candle_backfills.observations + excluded.observations,
            truncated = excluded.truncated,
            completed_at = excluded.completed_at`,
    args: [
      record.mint,
      record.oldestTimestamp,
      record.newestTimestamp,
      record.observations,
      record.truncated ? 1 : 0,
      now,
    ],
  });
}

export async function getBackfill(db: Client, mint: string): Promise<BackfillRecord | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM candle_backfills WHERE mint = ?',
    args: [mint],
  });
  const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    mint: String(row['mint']),
    oldestTimestamp: row['oldest_timestamp'] === null ? null : Number(row['oldest_timestamp']),
    newestTimestamp: row['newest_timestamp'] === null ? null : Number(row['newest_timestamp']),
    observations: Number(row['observations']),
    truncated: Number(row['truncated']) === 1,
    completedAt: Number(row['completed_at']),
  };
}

/**
 * The high and low over a span, from the candles the chart already uses.
 *
 * Analytics asks how well an entry or exit was timed, which only means
 * something against the range the market actually offered. Reading it from the
 * same table the chart is drawn from is deliberate: a trader who is told they
 * sold near the low can look at the chart and see the same low.
 *
 * Returns null when no candle covers the span — a position held inside a gap
 * in the backfill has no range to be judged against, and inventing one would
 * produce a confident number about nothing.
 */
export async function priceRange(
  db: Client,
  mint: string,
  timeframe: string,
  fromSeconds: number,
  toSeconds: number,
): Promise<{ high: bigint; low: bigint } | null> {
  // Compared in JavaScript as bigints rather than by SQL MAX/MIN. Prices are
  // stored as digit strings, and text comparison orders '900' below '90' —
  // which would understate the high on any token whose price gained a digit
  // during the hold, quietly and without ever looking wrong.
  const result = await db.execute({
    sql: `SELECT high, low FROM candles
          WHERE mint = ? AND timeframe = ? AND open_time >= ? AND open_time <= ?`,
    args: [mint, timeframe, fromSeconds, toSeconds],
  });

  let high: bigint | null = null;
  let low: bigint | null = null;
  for (const candle of result.rows) {
    const candleHigh = BigInt(String(candle['high']));
    const candleLow = BigInt(String(candle['low']));
    if (high === null || candleHigh > high) high = candleHigh;
    if (low === null || candleLow < low) low = candleLow;
  }

  return high === null || low === null ? null : { high, low };
}

/**
 * The last price each of these mints was seen at, from candles already stored.
 *
 * A leaderboard has to mark open positions at something. Reading the chain for
 * every held token is the accurate way and it does not finish: fourteen
 * accounts holding twenty-nine tokens is twenty-nine pool resolutions, each
 * several round trips, racing a four second budget against every other job on
 * the box. Twenty-nine of twenty-nine came back unpriced, so every position was
 * held at cost and every row on the board read exactly what it started with, no
 * matter how well or badly it had traded.
 *
 * This is the same number, already on disk. The curve watcher, the price feed
 * and the chart warmer all write candles, so the most recent close of the
 * shortest timeframe is a price the site has already paid for. It costs one
 * query for the whole board and it cannot time out.
 *
 * Deliberately not a substitute for reading the chain when a fill is being
 * quoted. A fill must never be priced from anything cached, and is not. This is
 * for marking, where a price a minute old is the difference between a board
 * that works and a board of ties.
 */
export async function lastPrices(
  db: Client,
  mints: readonly string[],
  /** Ignore anything older than this, in unix seconds. */
  notBefore = 0,
): Promise<Map<string, string>> {
  const prices = new Map<string, string>();
  if (mints.length === 0) return prices;

  for (let i = 0; i < mints.length; i += 200) {
    const batch = mints.slice(i, i + 200);
    const holes = batch.map(() => '?').join(', ');
    const result = await db.execute({
      sql: `SELECT mint, close, open_time FROM candles
            WHERE mint IN (${holes}) AND open_time >= ?
              AND open_time = (
                SELECT MAX(open_time) FROM candles c2
                WHERE c2.mint = candles.mint AND c2.timeframe = candles.timeframe
              )
            GROUP BY mint
            HAVING MAX(open_time)`,
      args: [...batch, notBefore],
    });
    for (const row of result.rows) {
      const close = String(row['close'] ?? '');
      if (close !== '') prices.set(String(row['mint']), close);
    }
  }
  return prices;
}
