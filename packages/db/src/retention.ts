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
 * How many candles to keep per token per timeframe.
 *
 * Kept by count, not by age. pump.fun's own chart serves at most a thousand
 * candles of any interval, from launch, so keeping a little more than that per
 * timeframe holds a chart's whole history — matching pump.fun at every timeframe
 * — while still bounding the table. And it bounds it the way that matters: the
 * growth that once filled the disk was the short timeframes writing a fresh row
 * every few seconds with no cap, and a per-timeframe row cap is exactly that cap,
 * tightest where the rows are. Ageing them out instead would delete a sparse old
 * token's early candles — few in number but reaching back months — which are the
 * whole point of a full chart.
 */
export const CANDLE_KEEP = 1_200;

/**
 * How long a token's candles are kept after anybody last looked at one.
 *
 * The count cap alone bounds a token and does not bound the table: every mint
 * anyone opens keeps its full set for ever, and a feed that charts thousands a
 * day fills a volume with the history of tokens nobody will open again. Whole
 * mints are dropped once they have gone quiet, which is the only eviction that
 * scales with the feed rather than with the number of timeframes.
 *
 * A held token is never dropped, however quiet: its chart belongs to a position
 * somebody still owns.
 */
const MINT_IDLE_SECONDS = 2 * 24 * 60 * 60;

/**
 * Drop every candle of a token that has gone quiet.
 *
 * Judged by the newest candle the token has: the writers keep it current for
 * anything being charted or watched, so an old newest means nothing has touched
 * this mint in days. Tokens somebody holds are kept regardless.
 */
export async function pruneIdleMints(db: Client, now: number): Promise<number> {
  const cutoff = Math.floor(now / 1_000) - MINT_IDLE_SECONDS;
  const result = await db.execute({
    sql: `DELETE FROM candles WHERE mint IN (
            SELECT mint FROM candles
            GROUP BY mint
            HAVING MAX(open_time) < ?
          )
          AND mint NOT IN (SELECT mint FROM positions)`,
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

/** Pool snapshots older than this are dropped, except the newest per mint. */
const POOL_SNAPSHOT_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Launches older than this are dropped, unless a token is still held.
 *
 * The feed only ever asks for the most recent launches, so an old row is dead
 * weight there. The one thing that must survive is a token somebody owns: its
 * name and symbol are read from this table to label the position, so a held
 * mint is kept however old it is.
 */
const LAUNCH_WINDOW_SECONDS = 14 * 24 * 60 * 60;

export interface RetentionResult {
  readonly candlesDeleted: number;
  readonly poolSnapshotsDeleted: number;
  readonly launchesDeleted: number;
}

/**
 * Drop candles beyond the most recent `CANDLE_KEEP` of each timeframe.
 *
 * Kept per token and per timeframe independently — a token's daily series and
 * its one-second series each keep their own most-recent `CANDLE_KEEP`, so a
 * chart's whole history survives on every timeframe while the row count stays
 * bounded. One statement, ranking every candle within its (mint, timeframe)
 * newest-first and deleting past the cap.
 */
export async function pruneCandles(db: Client): Promise<number> {
  const result = await db.execute({
    sql: `DELETE FROM candles WHERE (mint, timeframe, open_time) IN (
            SELECT mint, timeframe, open_time FROM (
              SELECT mint, timeframe, open_time,
                     ROW_NUMBER() OVER (
                       PARTITION BY mint, timeframe ORDER BY open_time DESC
                     ) AS rn
              FROM candles
            ) WHERE rn > ?
          )`,
    args: [CANDLE_KEEP],
  });
  return Number(result.rowsAffected ?? 0);
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
  // observed_at is written in milliseconds (Date.now()), not the unix seconds
  // that candles and launches use, so the cutoff is milliseconds too. Getting
  // this wrong makes the comparison never true and the prune a silent no-op.
  const cutoff = now - POOL_SNAPSHOT_WINDOW_SECONDS * 1_000;
  const result = await db.execute({
    sql: `DELETE FROM pool_snapshots
          WHERE observed_at < ?
            AND id NOT IN (SELECT MAX(id) FROM pool_snapshots GROUP BY mint)`,
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

/**
 * Drop launches too old for the feed, keeping any token still held.
 *
 * The pump.fun firehose writes a row per token created, tens of thousands a
 * day, and nothing else deleted them — the same shape of growth that filled the
 * disk with candles. A held token is spared whatever its age, because its row
 * is what names the position on screen.
 */
export async function pruneLaunches(db: Client, now: number): Promise<number> {
  const cutoff = Math.floor(now / 1_000) - LAUNCH_WINDOW_SECONDS;
  const result = await db.execute({
    sql: `DELETE FROM launches
          WHERE launched_at < ?
            AND NOT EXISTS (SELECT 1 FROM positions WHERE positions.mint = launches.mint)`,
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

/** Run every retention pass there is. Safe to call as often as you like. */
export async function runRetention(db: Client, now: number): Promise<RetentionResult> {
  return {
    candlesDeleted: (await pruneIdleMints(db, now)) + (await pruneCandles(db)),
    poolSnapshotsDeleted: await prunePoolSnapshots(db, now),
    launchesDeleted: await pruneLaunches(db, now),
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
