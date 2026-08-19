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
 * The cap per timeframe, where a flat one was wrong in both directions.
 *
 * The short timeframes are where every row is: a token being watched writes a
 * fifteen-second candle four times a minute, and twelve hundred of those is
 * five hours of a chart nobody scrolls back through. The long ones are the
 * opposite — a daily candle is one row a day and twelve hundred of them is
 * three years of history in the space the short ones use in an afternoon.
 *
 * Deep where rows are cheap, shallow where they are not. This is what actually
 * bounds the table: the fine timeframes across thousands of mints were the
 * growth that filled the volume, and no eviction by age touches them fast
 * enough while a token is still being watched.
 */
export const KEEP_BY_TIMEFRAME: Record<string, number> = {
  s1: 240,
  s5: 300,
  s15: 400,
  // The minute frames are what a trader actually scrolls back through on a
  // token that moved, and they were the shallowest thing here: 500 one-minute
  // candles is eight hours, on tokens whose whole story is often a single
  // afternoon. Doubled, which costs about 300KB per token at full depth.
  m1: 1_000,
  m5: 1_200,
  m15: 1_200,
  h1: 1_500,
  h4: 1_000,
  h12: 1_000,
  d1: 1_200,
};

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
/*
 * How long a token keeps its chart after the last person stops looking.
 *
 * Six hours was a disk measure, not a product one: a token opened this morning
 * lost its history by lunchtime, so coming back to it meant watching "reading
 * history" fill the chart again from scratch. Three days fixed that for the
 * week you are in and not for the one before it, so anything you traded a
 * fortnight ago still refetched from nothing.
 *
 * Fourteen days, which is the window launches are kept for. That is not a
 * coincidence worth breaking: past it the launch row naming the token is gone
 * too, so a chart that outlived it would be history belonging to something this
 * database can no longer label.
 *
 * This does not raise the ceiling. `MINT_BUDGET` still caps how many tokens may
 * keep candles at all, so the size of the table is unchanged and what moves is
 * which tokens fill it: the budget's recency ranking decides, rather than a
 * token being dropped for going quiet for a long weekend.
 */
const MINT_IDLE_SECONDS = 14 * 24 * 60 * 60;

/**
 * Drop every candle of a token that has gone quiet.
 *
 * Judged by the newest candle the token has: the writers keep it current for
 * anything being charted or watched, so an old newest means nothing has touched
 * this mint in days. Tokens somebody holds are kept regardless.
 */
export async function pruneIdleMints(db: Client, now: number): Promise<number> {
  const cutoff = Math.floor(now / 1_000) - MINT_IDLE_SECONDS;
  const stale = await db.execute({
    sql: `SELECT mint FROM candles
          GROUP BY mint
          HAVING MAX(open_time) < ?
          EXCEPT SELECT mint FROM positions`,
    args: [cutoff],
  });
  const mints = stale.rows.map((row) => String(row['mint']));
  if (mints.length === 0) return 0;

  const marks = mints.map(() => '?').join(',');
  const result = await db.execute({
    sql: `DELETE FROM candles WHERE mint IN (${marks})`,
    args: mints,
  });

  /*
   * The walk record goes with them.
   *
   * A token is only ever walked once, and the record of that walk is what says
   * so. Dropping its candles and keeping the record leaves it marked as having
   * a history it no longer has, and nothing will ever fetch it again: the chart
   * opens empty, for good. They are one thing and are removed as one.
   */
  await db.execute({
    sql: `DELETE FROM candle_backfills WHERE mint IN (${marks})`,
    args: mints,
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
/**
 * Timeframes nothing can display, dropped outright.
 *
 * The chart offers fifteen seconds and up. One-second and five-second candles
 * were written for every watched token and shown to nobody, and a row per
 * second per token is the largest thing that has ever been on this disk. They
 * are no longer written; these are the ones already there.
 */
const UNUSED_TIMEFRAMES = ['s1', 's5'];

export async function pruneUnusedTimeframes(db: Client): Promise<number> {
  const marks = UNUSED_TIMEFRAMES.map(() => '?').join(',');
  const result = await db.execute({
    sql: `DELETE FROM candles WHERE timeframe IN (${marks})`,
    args: UNUSED_TIMEFRAMES,
  });
  return Number(result.rowsAffected ?? 0);
}

/**
 * How many tokens may keep candles at all.
 *
 * The per-timeframe caps bound a token and say nothing about how many tokens
 * there are, which is the half that actually decides the size of the table. A
 * token costs roughly six and a half thousand rows across the timeframes kept,
 * and every row carries a forty-four character mint, five numeric strings and
 * its share of the index: call it a megabyte and a half. A feed that charts
 * thousands of tokens a day will fill any volume given long enough, and a
 * bigger volume only moves the date.
 *
 * This is the ceiling. Whatever the feed does, the table is this many tokens
 * wide, and the space it needs can be worked out in advance rather than
 * discovered when writes start failing.
 */
/*
 * How many tokens keep a chart.
 *
 * 160 was chosen for a 454MB volume that had just been filled by unbounded
 * candles. The volume is 4.69GB now, and 160 fully backfilled mints is 245MB of
 * it, so the pruner was throwing away history to protect a disk that is 95%
 * empty. At the depths below a token costs about 2MB, so 1,200 of them is
 * 2.35GB: half the volume, leaving the rest for the database proper, the WAL,
 * the snapshot file and the full copy that compaction makes. Half rather than
 * two thirds because compaction needs room for a second copy of the database,
 * and a disk that is 90% full at rest has nowhere to make one.
 *
 * Still an env var, and still bounded. The lesson from that outage was not that
 * the number was too low, it was that there was no number at all.
 */
const MINT_BUDGET = Number(process.env['PROBATIO_CANDLE_MINTS'] ?? '1200');

/**
 * Drop the candles of every token past the budget, oldest activity first.
 *
 * Recency is judged by the newest candle a token has, which the writers keep
 * current for anything being charted or watched, so what survives is what is
 * being looked at. A token somebody holds is kept regardless of where it falls,
 * because that chart belongs to a position they still own.
 */
export async function pruneToMintBudget(db: Client): Promise<number> {
  const ranked = await db.execute({
    sql: `SELECT mint FROM (
            SELECT mint, MAX(open_time) AS last_seen
            FROM candles GROUP BY mint
            ORDER BY last_seen DESC
            LIMIT -1 OFFSET ?
          )
          EXCEPT SELECT mint FROM positions`,
    args: [MINT_BUDGET],
  });
  const mints = ranked.rows.map((row) => String(row['mint']));
  if (mints.length === 0) return 0;

  let deleted = 0;
  // In batches, so a volume with little room to write a journal is not asked
  // to do the whole thing in one statement.
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    const marks = batch.map(() => '?').join(',');
    const result = await db.execute({
      sql: `DELETE FROM candles WHERE mint IN (${marks})`,
      args: batch,
    });
    await db.execute({ sql: `DELETE FROM candle_backfills WHERE mint IN (${marks})`, args: batch });
    deleted += Number(result.rowsAffected ?? 0);
  }
  return deleted;
}

export async function pruneCandles(db: Client): Promise<number> {
  // One statement per timeframe, because each keeps a different depth and a
  // single cap would either strand the short ones or starve the long ones.
  const found = await db.execute('SELECT DISTINCT timeframe FROM candles');
  let deleted = 0;

  for (const row of found.rows) {
    const timeframe = String(row['timeframe']);
    const keep = KEEP_BY_TIMEFRAME[timeframe] ?? CANDLE_KEEP;
    const result = await db.execute({
      sql: `DELETE FROM candles WHERE (mint, timeframe, open_time) IN (
              SELECT mint, timeframe, open_time FROM (
                SELECT mint, timeframe, open_time,
                       ROW_NUMBER() OVER (
                         PARTITION BY mint ORDER BY open_time DESC
                       ) AS rn
                FROM candles WHERE timeframe = ?
              ) WHERE rn > ?
            )`,
      args: [timeframe, keep],
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
 *
 * A snapshot some trade was priced against is kept for ever, however old.
 * `trades.pool_snapshot_id` is a foreign key, so deleting one was not merely
 * wrong, it threw: measured on a real database, fourteen snapshots older than
 * the window were still referenced, every sweep failed on the constraint, and
 * because the passes ran as one expression the launch prune below never ran at
 * all. The pump.fun firehose writes a row per token created, so what looked
 * like a stale-snapshot bug was quietly costing tens of thousands of launch
 * rows a day.
 *
 * Keeping them is also the right answer on the merits, independently of the
 * constraint. That snapshot is the reserves the fill was quoted against. It is
 * the evidence for the trade, and the record stops being checkable without it.
 */
export async function prunePoolSnapshots(db: Client, now: number): Promise<number> {
  // observed_at is written in milliseconds (Date.now()), not the unix seconds
  // that candles and launches use, so the cutoff is milliseconds too. Getting
  // this wrong makes the comparison never true and the prune a silent no-op.
  const cutoff = now - POOL_SNAPSHOT_WINDOW_SECONDS * 1_000;
  const result = await db.execute({
    sql: `DELETE FROM pool_snapshots
          WHERE observed_at < ?
            AND id NOT IN (SELECT MAX(id) FROM pool_snapshots GROUP BY mint)
            AND id NOT IN (SELECT pool_snapshot_id FROM trades)`,
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

/**
 * Run one pass, and report a failure rather than taking the others down.
 *
 * These were a single expression, so the first pass to throw abandoned every
 * pass after it. That is the worst possible arrangement for this job: the whole
 * point of retention is to keep the disk from filling, and the failure mode was
 * one broken statement silently disabling the passes that free the most space.
 * The disk then fills exactly as though nothing were running, because nothing
 * is. Each pass now stands alone.
 */
async function attempt(label: string, pass: () => Promise<number>): Promise<number> {
  try {
    return await pass();
  } catch (error) {
    console.error(`[retention] ${label} failed`, error);
    return 0;
  }
}

/** Run every retention pass there is. Safe to call as often as you like. */
export async function runRetention(db: Client, now: number): Promise<RetentionResult> {
  const candlesDeleted =
    (await attempt('unused timeframes', () => pruneUnusedTimeframes(db))) +
    (await attempt('idle mints', () => pruneIdleMints(db, now))) +
    (await attempt('mint budget', () => pruneToMintBudget(db))) +
    (await attempt('candle depth', () => pruneCandles(db)));

  return {
    candlesDeleted,
    poolSnapshotsDeleted: await attempt('pool snapshots', () => prunePoolSnapshots(db, now)),
    launchesDeleted: await attempt('launches', () => pruneLaunches(db, now)),
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
