import 'server-only';
import { createClient } from '@libsql/client';
import { runRetention } from '@probatio/db';
import { copyFileSync, existsSync, rmSync, statfsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { databaseUrl } from './env';

/**
 * Give a nearly-full database disk its room back before the app opens it.
 *
 * The candle table can grow until it fills the volume, and a full volume fails
 * every write — including the deletes that would free it, so the database
 * cannot dig itself out in place. The way out is off the volume: the compacted
 * database is small, so it is rebuilt on the container's own disk (a separate,
 * roomy filesystem) and swapped back in.
 *
 * Runs once, before the connection the rest of the app shares is opened, and
 * only when the disk is genuinely tight — the normal case is that retention
 * kept it well under and this returns immediately. Everything it touches is
 * re-derivable chart data; accounts, entries, and payments ride along in the
 * copy untouched.
 */

/** Reclaim when less than this is free on the database's disk. */
const TIGHT_BYTES = 64 * 1024 * 1024;

function filePath(url: string): string | null {
  if (!url.startsWith('file:')) return null;
  return url.slice('file:'.length).replace(/^\/+/, '/');
}

function freeBytes(dir: string): number | null {
  try {
    const fs = statfsSync(dir);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    // No statfs (old runtime, unusual filesystem): treat as unknown and leave
    // the disk alone rather than reclaiming blind.
    return null;
  }
}

function remove(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Already gone, which is the state we wanted.
    }
  }
}

export async function reclaimIfTight(): Promise<void> {
  const url = databaseUrl();
  const path = filePath(url);
  if (!path) return; // A remote database is not our disk to manage.

  const staging = join(tmpdir(), 'probatio-reclaim.db');

  // A reclaim interrupted mid-swap leaves the live file gone and the compacted
  // copy still on the container disk. Put it back rather than starting empty.
  if (!existsSync(path)) {
    if (existsSync(staging)) {
      try {
        copyFileSync(staging, path);
        console.log('[reclaim] restored database from an interrupted reclaim');
      } catch (error) {
        console.error('[reclaim] could not restore the staged database', error);
      }
    }
    return;
  }

  const free = freeBytes(dirname(path));
  if (free === null || free > TIGHT_BYTES) return;

  console.warn(`[reclaim] ${Math.round(free / 1e6)}MB free; compacting the database off-volume`);

  try {
    // 1. A consistent, compacted copy onto the roomy container disk. Reads the
    //    live database only, so a volume with nothing left to write can still
    //    produce it.
    remove(staging);
    const source = createClient({ url });
    try {
      await source.execute({ sql: `VACUUM INTO '${staging.replace(/'/g, "''")}'` });
    } finally {
      source.close();
    }

    // 2. Drop the history that filled the disk and rewrite the copy compact.
    //    All of this happens on the container disk, where there is room.
    const staged = createClient({ url: `file:${staging}` });
    try {
      const dropped = await runRetention(staged, Date.now());
      console.log(`[reclaim] dropped ${dropped.candlesDeleted} candles off-volume`);
      await staged.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      await staged.execute('VACUUM');
    } finally {
      staged.close();
    }

    // 3. Swap the small copy in. The volume has no room for both, so the big
    //    one goes first; the copy stays in staging so step one above can
    //    recover if the process dies between these two lines.
    remove(path);
    copyFileSync(staging, path);
    console.log(`[reclaim] database is now ${Math.round(statSync(path).size / 1e6)}MB`);
  } catch (error) {
    // Better a database still tight than one left half-swapped. If the live
    // file survived, the app opens it as before; if it did not, the recovery
    // at the top of the next boot restores the staged copy.
    console.error('[reclaim] could not reclaim disk; leaving the database as it is', error);
  }
}
