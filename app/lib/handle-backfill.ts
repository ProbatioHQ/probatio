import 'server-only';
import { backfillTwitterHandles } from '@probatio/db';
import { db } from './db';

/**
 * Filling in the X handle for metadata written before the column existed.
 *
 * The reuse condition counts how many tokens name the same account, so a row
 * carrying a link and no handle read from it is a launch that counts towards
 * nobody's total. Forty thousand of those would make a serial promoter look
 * like a first-timer, which is the signal inverted rather than merely missing.
 *
 * WHY IT IS A TASK AND NOT A SCRIPT
 *
 * It was a script, and a script is an instruction to a person. Every deploy
 * that ran the migration and not the script would leave the condition quietly
 * wrong, and nothing anywhere would say so. A job that converges and then stops
 * needs nobody to remember it.
 *
 * It is deliberately not a migration either. Migrations run inside the boot
 * path and hold everything else up; this rewrites tens of thousands of rows and
 * has no business delaying a server coming back.
 *
 * WHAT MAKES IT SAFE TO LEAVE RUNNING
 *
 * It only ever touches rows that have a link and no handle, so once it has
 * caught up there is nothing left to find and it stops for the life of the
 * process. New rows normalise as they are written, so it never has to run
 * again — it is here for the ones already stored.
 */

/** Rows per pass. Small enough that it never holds the writer lock for long. */
const BATCH = 300;

/** Between passes. Slow on purpose: nothing is waiting on this. */
const PAUSE_MS = 2_000;

interface State {
  running: boolean;
  filled: number;
  done: boolean;
}

const KEY = Symbol.for('probatio.handle-backfill');

function state(): State {
  const store = globalThis as unknown as Record<symbol, State | undefined>;
  const existing = store[KEY];
  if (existing) return existing;
  const fresh: State = { running: false, filled: 0, done: false };
  store[KEY] = fresh;
  return fresh;
}

export function handleBackfillStatus(): State {
  return { ...state() };
}

export function startHandleBackfill(): void {
  const current = state();
  if (current.running || current.done) return;
  current.running = true;

  const sweep = async (): Promise<void> => {
    const client = await db();
    for (;;) {
      const written = await backfillTwitterHandles(client, BATCH);
      if (written === 0) break;
      current.filled += written;
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
    current.done = true;
    current.running = false;
    if (current.filled > 0) {
      console.log(`[handles] read ${current.filled} X links into handles`);
    }
  };

  void sweep().catch((error) => {
    current.running = false;
    // Left un-done, so a restart tries again. A failure here costs the reuse
    // condition its history, which is worth another attempt.
    console.error('[handles] backfill failed', error);
  });
}
