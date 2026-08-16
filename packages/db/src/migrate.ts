import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { enforceIntegrity } from './client';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface AppliedMigration {
  readonly name: string;
  readonly appliedAt: number;
}

async function ensureLedger(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

export async function appliedMigrations(client: Client): Promise<AppliedMigration[]> {
  await ensureLedger(client);
  const result = await client.execute('SELECT name, applied_at FROM _migrations ORDER BY name');
  return result.rows.map((row) => ({
    name: String(row['name']),
    appliedAt: Number(row['applied_at']),
  }));
}

/**
 * A single migrate at a time across the whole process.
 *
 * Next.js runs the instrumentation bundle and the request bundle as separate
 * module instances that share one database file, and each opens its own
 * connection and calls migrate() on boot. Run at once, both saw the same
 * migration as unapplied, both ran it, and the second's ledger insert failed
 * the primary key — a thrown error that poisons the shared init promise and
 * takes the database "down" for the life of the process. The lock lives on
 * globalThis so it is shared across those bundles, and serialises them: the
 * second waits, then finds everything already applied and does nothing.
 */
const MIGRATE_LOCK = Symbol.for('probatio.db.migrate-lock');

function migrateChain(): { chain: Promise<unknown> } {
  const store = globalThis as typeof globalThis & { [MIGRATE_LOCK]?: { chain: Promise<unknown> } };
  store[MIGRATE_LOCK] ??= { chain: Promise.resolve() };
  return store[MIGRATE_LOCK];
}

/**
 * Apply every migration that has not run yet, in filename order.
 *
 * Migrations are never re-run and never rolled back. A mistake in a shipped
 * migration is corrected by a new migration, for the same reason a trade is
 * corrected by a new trade — anything already committed on chain was computed
 * against the schema as it stood.
 */
export async function migrate(client: Client): Promise<string[]> {
  const lock = migrateChain();
  const run = lock.chain.then(() => applyMigrations(client));
  // Keep the chain alive even if this run rejects, so a later call still waits
  // its turn rather than racing.
  lock.chain = run.catch(() => undefined);
  return run;
}

async function applyMigrations(client: Client): Promise<string[]> {
  await enforceIntegrity(client);
  await ensureLedger(client);

  const done = new Set((await appliedMigrations(client)).map((m) => m.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await client.executeMultiple(sql);
    // OR IGNORE so that a ledger row already written by a concurrent run is not
    // an error — belt and braces alongside the lock above.
    await client.execute({
      sql: 'INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)',
      args: [file, Date.now()],
    });
    ran.push(file);
  }

  return ran;
}
