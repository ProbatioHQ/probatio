import 'server-only';
import { runRetention } from '@probatio/db';
import { db } from './db';

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

const SWEEP_MS = 30 * 60 * 1_000;

async function sweep(): Promise<void> {
  const client = await db();
  const result = await runRetention(client, Date.now());
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
}

export function stopRetention(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
