import type { Client } from '@libsql/client';

/**
 * Keeping the database from growing without bound.
 *
 * The chart candles are the one table that grows on a timer rather than with
 * use: the curve watcher records a price for every watched token across every
 * timeframe every few seconds, and a one-second candle is a fresh row for each
 * distinct second. Left alone that table is the whole disk, and when the disk
 * fills every write fails and the database goes down with it.
 *
 * Nothing here is data anyone entered. Candles and pool snapshots are read from
 * the chain and can be rebuilt from it, so old ones are dropped once no chart
 * would ever ask for them again. What a person owns — accounts, entries,
 * payments, users — is never touched.
 */

/**
 * How long each timeframe's candles are worth keeping, in seconds.
 *
 * A chart shows the most recent few hundred candles of one timeframe, so the
 * window only has to hold comfortably more than that. A one-second candle is
 * useless an hour later; an hourly one is still part of a month's chart. The
 * short end is where all the rows are, so that is where the window is tightest.
 */
const CANDLE_WINDOW_SECONDS: Record<string, number> = {
  s1: 60 * 60, // one hour
  s5: 6 * 60 * 60, // six hours
  s15: 12 * 60 * 60, // half a day
  m1: 3 * 24 * 60 * 60, // three days
  m5: 14 * 24 * 60 * 60, // two weeks
  m15: 60 * 24 * 60 * 60, // two months
  h1: 365 * 24 * 60 * 60, // a year
};

/** Timeframes without an explicit window keep this long. */
const DEFAULT_WINDOW_SECONDS = 3 * 24 * 60 * 60;

/** Pool snapshots older than this are dropped, except the newest per mint. */
const POOL_SNAPSHOT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export interface RetentionResult {
  readonly candlesDeleted: number;
  readonly poolSnapshotsDeleted: number;
}

/**
 * Drop candles no chart would draw any more.
 *
 * Done one timeframe at a time because each keeps its history for a different
 * length: batching them under a single cutoff would either throw away an hour
 * of hourly candles or keep a day of one-second ones. `open_time` is unix
 * seconds, the same clock the candles are written on.
 */
export async function pruneCandles(db: Client, now: number): Promise<number> {
  const nowSeconds = Math.floor(now / 1_000);
  let deleted = 0;

  const timeframes = await db.execute('SELECT DISTINCT timeframe FROM candles');
  for (const row of timeframes.rows) {
    const timeframe = String(row['timeframe']);
    const window = CANDLE_WINDOW_SECONDS[timeframe] ?? DEFAULT_WINDOW_SECONDS;
    const cutoff = nowSeconds - window;
    const result = await db.execute({
      sql: 'DELETE FROM candles WHERE timeframe = ? AND open_time < ?',
      args: [timeframe, cutoff],
    });
    deleted += Number(result.rowsAffected ?? 0);
  }

  return deleted;
}

/**
 * Drop stale pool snapshots, keeping the most recent one for each mint.
 *
 * The latest snapshot is a token's last known price and is kept whatever its
 * age, so a token nobody has looked at in a week still has a number. Everything
 * older than the window and not the latest is history the chart already turned
 * into candles.
 */
export async function prunePoolSnapshots(db: Client, now: number): Promise<number> {
  const cutoff = Math.floor(now / 1_000) - POOL_SNAPSHOT_WINDOW_SECONDS;
  const result = await db.execute({
    sql: `DELETE FROM pool_snapshots
          WHERE observed_at < ?
            AND id NOT IN (SELECT MAX(id) FROM pool_snapshots GROUP BY mint)`,
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

/** Run every retention pass there is. Safe to call as often as you like. */
export async function runRetention(db: Client, now: number): Promise<RetentionResult> {
  return {
    candlesDeleted: await pruneCandles(db, now),
    poolSnapshotsDeleted: await prunePoolSnapshots(db, now),
  };
}

/**
 * Reclaim the space freed rows leave behind.
 *
 * A delete returns pages to a free list inside the file; the file itself does
 * not shrink until it is rewritten, so a database that filled the disk once
 * would sit at that size for ever, reusing its own free pages but never giving
 * the disk back. `VACUUM` rewrites it compact.
 *
 * It needs room to write the new copy, so it is the caller's job not to run it
 * against a disk with no room to spare — reclaiming space is exactly what that
 * caller cannot do here. Cannot run inside a transaction, so it takes the raw
 * client and issues the one statement.
 */
export async function compact(db: Client): Promise<void> {
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  await db.execute('VACUUM');
}
