import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@libsql/client';
import { openDatabase } from './client';
import { migrate } from './migrate';

/**
 * A throwaway database for tests.
 *
 * Backed by a temporary file rather than `:memory:`, and that is not a
 * preference. libsql opens a separate connection for a transaction, and two
 * connections to `:memory:` are two different databases — so the first
 * `db.transaction()` sees an empty schema and, worse, leaves the original
 * connection looking at nothing. Tables migrated a moment earlier simply
 * vanish.
 *
 * The failure is quiet and misleading: the error says a table does not exist,
 * which reads like a missing migration rather than a connection that was never
 * looking at the same database. Anything exercising a transaction has to use a
 * real file.
 */
export interface TestDatabase {
  readonly db: Client;
  /** Removes the temporary file. Safe to call more than once. */
  readonly cleanup: () => void;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const directory = mkdtempSync(join(tmpdir(), 'probatio-test-'));
  const db = openDatabase({ url: `file:${join(directory, 'test.db')}` });
  await migrate(db);

  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // Already closed; nothing to do.
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
