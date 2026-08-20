import 'server-only';
import { runRetention } from '@probatio/db';
import { background } from './background-write';
import { snapshotAccounts } from './account-backup';
import { db } from './db';
import { reclaimIfTight } from './db-reclaim';

/**
 * Keeps the database from growing until it fills the disk.
 *
 * The curve watcher writes chart candles for every watched token on a timer, so
 * that table grows whether or not anybody is trading. Left alone it is the whole
 * disk within days, and a full disk fails every write, which takes the database
 * down. This drops candles too old for any chart to draw.
 *
 * It does NOT run VACUUM. VACUUM rewrites the whole file, and a rewrite killed
 * partway through — which a container swap on every deploy does — can leave the
 * database corrupt. The deletes here already bound the working set, and the
 * pages they free are reused by later writes, so the file plateaus rather than
 * growing without end. Reclaiming the file back to the disk is left to the
 * boot-time step in db-reclaim, which only runs when the disk is genuinely tight
 * and does its rewrite off the volume, never in place.
 *
 * Best effort, and quiet about it: a sweep that could not run is tried again
 * next time, never a reason to take the server down.
 */

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;

const SWEEP_MS = 8 * 60 * 1_000;
/*
 * The account tables are copied far more often than the sweep runs.
 *
 * A snapshot is only worth what it would cost to fall back to it, and half an
 * hour of somebody's trading is too much to lose to a file being replaced. It
 * is a few kilobytes and it writes in milliseconds.
 */
const SNAPSHOT_MS = 3 * 60 * 1_000;

async function sweep(): Promise<void> {
  /*
   * Reclaim first, on every sweep rather than only at boot.
   *
   * It used to run once as the process started, so a volume that filled while
   * the process was up stayed full: deleting rows needs somewhere to write the
   * journal, and with nothing free even the pruning below cannot run. The
   * reclaim compacts off the volume, where there is room, and is the only thing
   * that can dig the database out once it is genuinely full. It returns
   * immediately unless the disk is actually tight.
   */
  await reclaimIfTight().catch((error) => console.error('[retention] reclaim failed', error));

  const client = await db();
  // Queued with the other background writers. Retention is a long run of
  // deletes and it lost whole passes to a busy file the moment the wallet
  // walker went parallel: it is the least urgent writer here and the one that
  // should wait, rather than the one that should fail.
  const result = await background(() => runRetention(client, Date.now()));
  if (result.candlesDeleted > 0 || result.poolSnapshotsDeleted > 0 || result.launchesDeleted > 0) {
    console.log(
      `[retention] dropped ${result.candlesDeleted} candles, ` +
        `${result.poolSnapshotsDeleted} pool snapshots, ${result.launchesDeleted} launches`,
    );
  }
}

export function startRetention(): void {
  if (started) return;
  started = true;

  const run = (): void => {
    void sweep().catch((error) => console.error('[retention] sweep failed', error));
  };

  run();
  timer = setInterval(run, SWEEP_MS);
  timer.unref?.();

  const copy = (): void => {
    void db()
      .then((client) => snapshotAccounts(client))
      .catch((error) => console.error('[backup] snapshot failed', error));
  };
  copy();
  snapshotTimer = setInterval(copy, SNAPSHOT_MS);
  snapshotTimer.unref?.();
}

export function stopRetention(): void {
  if (timer) clearInterval(timer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  timer = null;
  snapshotTimer = null;
  started = false;
}
