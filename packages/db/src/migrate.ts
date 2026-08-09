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
 * Apply every migration that has not run yet, in filename order.
 *
 * Migrations are never re-run and never rolled back. A mistake in a shipped
 * migration is corrected by a new migration, for the same reason a trade is
 * corrected by a new trade — anything already committed on chain was computed
 * against the schema as it stood.
 */
export async function migrate(client: Client): Promise<string[]> {
  await enforceIntegrity(client);
  await ensureLedger(client);

  const done = new Set((await appliedMigrations(client)).map((m) => m.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await client.executeMultiple(sql);
    await client.execute({
      sql: 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
      args: [file, Date.now()],
    });
    ran.push(file);
  }

  return ran;
}
