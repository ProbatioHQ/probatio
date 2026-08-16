import 'server-only';
import { createClient } from '@libsql/client';
import { runRetention } from '@probatio/db';
import {
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Start fresh if the database has corrupted, rather than serving a broken one.
 *
 * A file whose pages are damaged answers `SQLITE_CORRUPT` on any query that
 * touches them, which is a failure no amount of retrying fixes. This happened
 * once, from a VACUUM interrupted by a deploy — a rewrite that no longer runs.
 * Caught here on boot: a database that fails its integrity check is set aside,
 * not deleted, and the next open creates a clean one. What is lost is the
 * re-derivable market history the corruption sat in; accounts and payments, if
 * intact, are the exact thing a manual wipe would have thrown away too.
 */
export async function recoverIfCorrupt(): Promise<void> {
  const url = databaseUrl();
  const path = filePath(url);
  if (!path || !existsSync(path)) return;

  let healthy = false;
  const probe = createClient({ url });
  try {
    const result = await probe.execute('PRAGMA quick_check');
    const first = result.rows[0];
    healthy = first !== undefined && Object.values(first).some((value) => value === 'ok');
  } catch {
    // A database too damaged even to check is not one to open.
    healthy = false;
  } finally {
    probe.close();
  }
  if (healthy) return;

  console.error('[db] database failed its integrity check; setting it aside and starting fresh');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${path}.corrupt${suffix}`);
    } catch (error) {
      console.error('[db] could not set the corrupt database aside', error);
    }
  }
}

export async function reclaimIfTight(): Promise<void> {
  const url = databaseUrl();
  const path = filePath(url);
  if (!path) return; // A remote database is not our disk to manage.

  const staging = join(tmpdir(), 'probatio-reclaim.db');
  // Marks the moment the live file is being replaced. On the container disk, so
  // it can be written even when the volume that holds the database is full.
  const marker = join(tmpdir(), 'probatio-reclaim.swapping');

  // A swap that was interrupted leaves this mark set: the live file may be
  // missing or half-written, and the staged copy is the last whole database.
  // Restore it and clear the mark before anything opens the live file.
  if (existsSync(marker)) {
    if (existsSync(staging)) {
      try {
        copyFileSync(staging, path);
        console.log('[reclaim] restored database from an interrupted reclaim');
      } catch (error) {
        console.error('[reclaim] could not restore the staged database', error);
      }
    }
    try {
      rmSync(marker, { force: true });
    } catch {
      // The mark is on the throwaway disk; a stuck one is cleared next boot.
    }
    return;
  }

  // No live file and no interrupted swap: a fresh install, nothing to reclaim.
  if (!existsSync(path)) return;

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
    //    one goes first. The mark is set before the removal and cleared after
    //    the copy, so a death anywhere in between is caught at the next boot,
    //    which restores the whole staged copy rather than opening a half-file.
    writeFileSync(marker, '');
    remove(path);
    copyFileSync(staging, path);
    try {
      rmSync(marker, { force: true });
    } catch {
      // Left set, the next boot restores from the staged copy needlessly but
      // harmlessly; not worth failing the reclaim over.
    }
    console.log(`[reclaim] database is now ${Math.round(statSync(path).size / 1e6)}MB`);
  } catch (error) {
    // Better a database still tight than one left half-swapped. If the live
    // file survived, the app opens it as before; if it did not, the recovery
    // at the top of the next boot restores the staged copy.
    console.error('[reclaim] could not reclaim disk; leaving the database as it is', error);
  }
}
