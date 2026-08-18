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
import { db as dbClient } from './db';

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

  /*
   * Only a database that says it is damaged is set aside.
   *
   * This used to treat any failure of the check as corruption, which is the
   * most destructive possible reading of "something went wrong". A locked file,
   * a busy timeout, a slow check on a large database, an I/O hiccup while the
   * container is still starting, a volume with no room left to open a
   * connection: every one of those came back as "corrupt", and the answer to
   * corrupt is to rename the live database aside so the next open builds an
   * empty one. Every account, position and trade on it goes with it, on a
   * deploy where nothing was actually wrong.
   *
   * So the two cases are separated. A check that runs and reports damage is
   * damage. A check that could not run is unknown, and the database is left
   * exactly where it is: a real corruption will announce itself again on the
   * next query, and losing nothing is recoverable in a way that losing
   * everything is not.
   */
  let verdict: 'ok' | 'damaged' | 'unknown' = 'unknown';
  const probe = createClient({ url });
  try {
    const result = await probe.execute('PRAGMA quick_check');
    const first = result.rows[0];
    const reported = first === undefined ? [] : Object.values(first).map((value) => String(value));
    verdict = reported.some((value) => value === 'ok') ? 'ok' : 'damaged';
  } catch (error) {
    // Only the errors that actually mean a malformed file. Anything else is a
    // database this process could not read, which is not the same thing.
    const message = error instanceof Error ? error.message : String(error);
    verdict = /SQLITE_CORRUPT|malformed|not a database|file is encrypted/i.test(message)
      ? 'damaged'
      : 'unknown';
    if (verdict === 'unknown') {
      console.error('[db] integrity check could not run; leaving the database untouched', error);
    }
  } finally {
    probe.close();
  }
  if (verdict !== 'damaged') return;

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

  /*
   * The dead weight goes first, because it costs nothing and may be all that
   * is needed.
   *
   * A database set aside as corrupt is renamed rather than deleted, so it sits
   * on the volume at full size for ever, and a compacted copy left behind by a
   * reclaim that could not finish sits there too. Neither is ever read again.
   * Removing them is the one way to free space on a volume with nothing free,
   * and everything below needs somewhere to write.
   */
  for (const dead of ['.corrupt', '.corrupt-wal', '.corrupt-shm', '.compacted']) {
    const stale = `${path}${dead}`;
    if (!existsSync(stale)) continue;
    try {
      const size = statSync(stale).size;
      rmSync(stale, { force: true });
      console.warn(`[reclaim] removed ${dead}, freeing ${Math.round(size / 1e6)}MB`);
    } catch (error) {
      console.error(`[reclaim] could not remove ${dead}`, error);
    }
  }

  try {
    // What must survive this, so the copy can be checked against it before it
    // is allowed to replace anything.
    let accountsBefore = 0;
    {
      const before = createClient({ url });
      try {
        const result = await before.execute('SELECT COUNT(*) AS n FROM accounts');
        accountsBefore = Number(result.rows[0]?.['n'] ?? 0);
      } catch {
        accountsBefore = 0;
      } finally {
        before.close();
      }
    }

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

    /*
     * 3. Swap the small copy in, without ever being without a database.
     *
     * This step used to delete the live file and then copy the staged one back
     * over it, with a marker recording that it was mid-swap. Both the staged
     * copy and the marker live on the container's own disk, which does not
     * survive the container. So a restart inside that window — a deploy, a
     * crash, a redeploy on a push — came back to a volume with no database and
     * a throwaway disk with no copy and no marker, and everything anybody had
     * done was gone. That is the shape of both losses.
     *
     * The compacted copy is moved onto the volume first and only then renamed
     * over the live file. A rename within one filesystem is atomic: at every
     * instant the path is either the old database or the new one, and there is
     * no moment where it is neither. If the volume cannot take the copy, the
     * reclaim is abandoned with the live database untouched, because running
     * out of room is a smaller problem than not having a database at all.
     */
    const beside = `${path}.compacted`;
    try {
      copyFileSync(staging, beside);
    } catch (error) {
      console.error('[reclaim] no room beside the database; leaving it alone', error);
      remove(beside);
      return;
    }

    // The copy is only worth swapping in if it still has the rows that cannot
    // be rebuilt. A compaction that lost them is a compaction to throw away.
    const check = createClient({ url: `file:${beside}` });
    let accounts = 0;
    try {
      const result = await check.execute('SELECT COUNT(*) AS n FROM accounts');
      accounts = Number(result.rows[0]?.['n'] ?? 0);
    } catch (error) {
      console.error('[reclaim] the compacted copy could not be read; leaving the database alone', error);
      remove(beside);
      return;
    } finally {
      check.close();
    }
    if (accounts < accountsBefore) {
      console.error(
        `[reclaim] the compacted copy has ${accounts} accounts against ${accountsBefore}; leaving the database alone`,
      );
      remove(beside);
      return;
    }

    writeFileSync(marker, '');
    // Atomic, and on the same filesystem, so there is no instant without a
    // database. The stale write-ahead files belong to the replaced file.
    renameSync(beside, path);
    remove(`${path}-wal`);
    remove(`${path}-shm`);
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

/**
 * How much room is left, and how much of it the database is using.
 *
 * Reported by the health endpoint because the failure this diagnoses is
 * invisible from everywhere else: when the volume fills, reads keep working and
 * every write fails, so a health check that probes by reading says the database
 * is fine while nothing can be recorded. A number here would have said what
 * eight identical 503s in a browser console could not.
 */
export function storageStats(): {
  databaseBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
} {
  const path = filePath(databaseUrl());
  if (path === null) return { databaseBytes: null, freeBytes: null, totalBytes: null };

  let databaseBytes: number | null = null;
  try {
    // The write-ahead log counts: it lives beside the file and takes the volume.
    databaseBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try {
        return sum + statSync(`${path}${suffix}`).size;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    databaseBytes = null;
  }

  let free: number | null = null;
  let total: number | null = null;
  try {
    const fs = statfsSync(dirname(path));
    free = Number(fs.bavail) * Number(fs.bsize);
    total = Number(fs.blocks) * Number(fs.bsize);
  } catch {
    free = null;
    total = null;
  }

  return { databaseBytes, freeBytes: free, totalBytes: total };
}

/**
 * Whether the database can actually be written to, and what it says if not.
 *
 * The health probe reads, so a volume that has filled or a lock that is never
 * released both report a healthy database while every authenticated request
 * fails. This does the one thing reading cannot: it writes, into a table that
 * exists for no other purpose, and hands back the error rather than swallowing
 * it. Reported unauthenticated so the failure can be seen from outside without
 * a session, which is exactly the situation where nobody can get one.
 */
export async function writeProbe(): Promise<{ ok: boolean; error: string | null }> {
  try {
    const client = await dbClient();
    await client.execute(
      'CREATE TABLE IF NOT EXISTS _write_probe (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)',
    );
    await client.execute({
      sql: `INSERT INTO _write_probe (id, at) VALUES (1, ?)
            ON CONFLICT (id) DO UPDATE SET at = excluded.at`,
      args: [Date.now()],
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The account-resolution path, walked step by step.
 *
 * Every authenticated endpoint failed together while a plain write landed
 * fine, which narrows the fault to whatever resolving an account does that a
 * write does not. Each step is run on its own here and reports its own error,
 * so the failing one names itself instead of being inferred from five
 * endpoints returning five hundred. Unauthenticated, because the situation
 * being diagnosed is one where nobody can hold a session.
 */
export async function seasonProbe(): Promise<Record<string, string>> {
  const steps: Record<string, string> = {};
  const run = async (name: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      const value = await work();
      steps[name] = `ok:${String(value)}`;
    } catch (error) {
      steps[name] = `FAILED:${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const client = await dbClient();
  const now = Date.now();

  await run('rankedSeason', async () => {
    const { currentRankedSeason } = await import('@probatio/db');
    const season = await currentRankedSeason(client, now);
    return season ? season.id : 'none';
  });

  let freeId: number | null = null;
  await run('freePlaySeason', async () => {
    const { ensureFreePlaySeason } = await import('@probatio/db');
    freeId = await ensureFreePlaySeason(client, now);
    return freeId;
  });

  await run('seasonRow', async () => {
    if (freeId === null) return 'skipped';
    const result = await client.execute({
      sql: 'SELECT id FROM seasons WHERE id = ?',
      args: [freeId],
    });
    return result.rows.length > 0 ? 'found' : 'MISSING';
  });

  /*
   * What is actually on the database, so a wipe cannot happen quietly.
   *
   * These went to zero once and nothing said so: every authenticated request
   * failed, the health endpoint reported the database as fine, and the first
   * sign was a trader noticing their balance had gone back to its opening
   * figure. Counted here so a redeploy that loses somebody's account is visible
   * from outside in one request.
   */
  await run('accountsTable', async () => {
    const result = await client.execute('SELECT COUNT(*) AS n FROM accounts');
    return String(result.rows[0]?.['n']);
  });

  await run('users', async () => {
    const result = await client.execute('SELECT COUNT(*) AS n FROM users');
    return String(result.rows[0]?.['n']);
  });

  await run('trades', async () => {
    const result = await client.execute('SELECT COUNT(*) AS n FROM trades');
    return String(result.rows[0]?.['n']);
  });

  await run('setAside', async () => {
    // A database previously judged corrupt is renamed rather than deleted, so
    // its presence is the record that a reset happened and what it cost.
    const path = filePath(databaseUrl());
    return path && existsSync(`${path}.corrupt`) ? 'A PREVIOUS DATABASE WAS SET ASIDE' : 'none';
  });

  return steps;
}
