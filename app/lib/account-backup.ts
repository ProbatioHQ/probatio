import 'server-only';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Client } from '@libsql/client';
import { databaseUrl } from './env';

/**
 * A copy of the only rows that cannot be rebuilt.
 *
 * Everything else in this database is derived from chain and comes back on its
 * own: candles, pool snapshots, launches, curve state. What does not come back
 * is what a person did — their wallet, their account, their balance, the trades
 * they made and the positions they hold. Those exist nowhere else.
 *
 * They have now been lost twice. Once to a boot-time integrity check that read
 * any failure as corruption, and again to something that replaced the file
 * while the derived tables were filling the volume. Each time the answer was to
 * find the specific cause and close it, and each time another way through
 * appeared. The rows are small enough that they do not need that argument
 * settled: a few kilobytes of them are written beside the database, and if the
 * database ever comes back without them, they are put back.
 *
 * Written as a plain snapshot rather than a second database, so nothing about
 * restoring it depends on the engine that lost them.
 */

const TABLES = ['users', 'accounts', 'positions', 'trades'] as const;

interface Snapshot {
  readonly at: number;
  readonly rows: Record<string, Record<string, unknown>[]>;
}

function snapshotPath(): string | null {
  const url = databaseUrl();
  if (!url.startsWith('file:')) return null;
  const file = url.slice('file:'.length);
  return join(dirname(file), 'accounts-snapshot.json');
}

/** How many trades to keep a copy of. A record grows; a safety net need not. */
const MAX_TRADES = 20_000;

export async function snapshotAccounts(client: Client): Promise<void> {
  const path = snapshotPath();
  if (path === null) return;

  try {
    const rows: Record<string, Record<string, unknown>[]> = {};
    for (const table of TABLES) {
      const limit = table === 'trades' ? ` ORDER BY id DESC LIMIT ${MAX_TRADES}` : '';
      const result = await client.execute(`SELECT * FROM ${table}${limit}`);
      rows[table] = result.rows.map((row) => ({ ...(row as unknown as object) }));
    }

    // Nothing is written over a good copy until the new one is complete, so an
    // interrupted write cannot leave a snapshot that is worse than none.
    mkdirSync(dirname(path), { recursive: true });
    const staging = `${path}.writing`;
    writeFileSync(staging, JSON.stringify({ at: Date.now(), rows } satisfies Snapshot));
    renameSync(staging, path);
  } catch (error) {
    console.error('[backup] could not snapshot the account tables', error);
  }
}

/**
 * Put the accounts back if the database came up without them.
 *
 * Only when there are none at all. A database with accounts on it is the
 * authority on them and is never written over from here; this is for the case
 * where the file has been replaced and everybody's balance has silently
 * returned to its opening figure.
 */
export async function restoreAccountsIfEmpty(client: Client): Promise<void> {
  const path = snapshotPath();
  if (path === null || !existsSync(path)) return;

  try {
    const present = await client.execute('SELECT COUNT(*) AS n FROM accounts');
    if (Number(present.rows[0]?.['n'] ?? 0) > 0) return;

    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
    const counts: string[] = [];

    for (const table of TABLES) {
      const rows = snapshot.rows[table] ?? [];
      if (rows.length === 0) continue;
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const marks = columns.map(() => '?').join(',');
        try {
          await client.execute({
            sql: `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${marks})`,
            args: columns.map((column) => row[column] as never),
          });
        } catch {
          // One row that no longer fits the schema is not a reason to abandon
          // the rest of somebody's account.
        }
      }
      counts.push(`${rows.length} ${table}`);
    }

    console.error(
      `[backup] the database came up with no accounts; restored ${counts.join(', ')} ` +
        `from the snapshot taken at ${new Date(snapshot.at).toISOString()}`,
    );
  } catch (error) {
    console.error('[backup] could not restore the account tables', error);
  }
}

/**
 * What the safety net currently holds, for the health endpoint.
 *
 * A backup nobody has looked at is a hope rather than a guarantee, and this one
 * exists because balances were lost twice. Reported so it can be seen from
 * outside that a copy exists, when it was taken and what is in it, without
 * anybody having to trust that the timer is running.
 */
export function snapshotState(): {
  exists: boolean;
  takenAt: string | null;
  accounts: number | null;
  trades: number | null;
} {
  const path = snapshotPath();
  if (path === null || !existsSync(path)) {
    return { exists: false, takenAt: null, accounts: null, trades: null };
  }
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
    return {
      exists: true,
      takenAt: new Date(snapshot.at).toISOString(),
      accounts: snapshot.rows['accounts']?.length ?? 0,
      trades: snapshot.rows['trades']?.length ?? 0,
    };
  } catch {
    return { exists: true, takenAt: null, accounts: null, trades: null };
  }
}
