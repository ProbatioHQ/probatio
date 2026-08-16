import 'server-only';
import { runRetention, compact } from '@probatio/db';
import { db } from './db';

/**
 * Keeps the database from growing until it fills the disk.
 *
 * The curve watcher writes chart candles for every watched token on a timer, so
 * that table grows whether or not anybody is trading. Left alone it is the whole
 * disk within days, and a full disk fails every write, which takes the database
 * down. This drops candles too old for any chart to draw, then once a day
 * rewrites the file compact so the freed space returns to the disk rather than
 * sitting inside the file for ever.
 *
 * Best effort, and quiet about it: a sweep that could not run is tried again
 * next time, never a reason to take the server down.
 */

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

const SWEEP_MS = 30 * 60 * 1_000;
const COMPACT_MS = 24 * 60 * 60 * 1_000;

let lastCompactAt = 0;

async function sweep(): Promise<void> {
  const client = await db();
  const now = Date.now();

  const result = await runRetention(client, now);
  if (result.candlesDeleted > 0 || result.poolSnapshotsDeleted > 0 || result.launchesDeleted > 0) {
    console.log(
      `[retention] dropped ${result.candlesDeleted} candles, ` +
        `${result.poolSnapshotsDeleted} pool snapshots, ${result.launchesDeleted} launches`,
    );
  }

  // Reclaiming the file is expensive and locks it, so it is done at most once a
  // day, and only after a prune has freed pages worth reclaiming.
  if (now - lastCompactAt >= COMPACT_MS) {
    lastCompactAt = now;
    try {
      await compact(client);
    } catch (error) {
      console.error('[retention] compact failed', error);
    }
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
