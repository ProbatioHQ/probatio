import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient, type Client, type Config } from '@libsql/client';

export type { Client } from '@libsql/client';

/**
 * Make sure a local file database can be opened.
 *
 * libSQL will not create missing parent directories, so a `file:/data/x.db`
 * on a host where `/data` does not yet exist (a fresh container, or a volume
 * whose mount path the app has never written to) fails to open and takes the
 * whole database down. Creating the directory up front turns that into a
 * working database instead of a boot failure. Only files are touched; a remote
 * URL or `:memory:` has no directory and is left alone.
 */
function ensureFileDirectory(url: string): void {
  if (!url.startsWith('file:')) return;
  const path = url.slice('file:'.length).replace(/^\/+/, '/');
  const dir = dirname(path);
  if (dir === '.' || dir === '/' || dir === '') return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Opening the database next will surface the real, actionable error.
  }
}

/**
 * Open a database connection.
 *
 * With no arguments this reads `DATABASE_URL` and `DATABASE_AUTH_TOKEN` from
 * the environment. Tests pass `:memory:` and get a private database that costs
 * nothing to throw away.
 */
export function openDatabase(config?: Partial<Config>): Client {
  const url = config?.url ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'No database URL. Set DATABASE_URL, or pass { url: ":memory:" } for an ephemeral one.',
    );
  }

  ensureFileDirectory(url);

  const authToken = config?.authToken ?? process.env['DATABASE_AUTH_TOKEN'];

  const client = createClient({
    ...config,
    url,
    ...(authToken ? { authToken } : {}),
  });

  // Local files get their writes serialized. A remote database does its own
  // concurrency control on the server, and queueing there would serialize
  // network round trips for nothing.
  return url.startsWith('file:') || url === ':memory:' ? serializeWrites(client) : client;
}

/**
 * One write transaction at a time.
 *
 * Found by load testing rather than by reading: 500 concurrent trades against a
 * local file produced 499 `SQLITE_BUSY` failures and one successful write. The
 * invariants held, because almost nothing was written — a safe failure and a
 * useless one.
 *
 * `PRAGMA busy_timeout` does not fix it. libsql hands each transaction its own
 * connection, and the pragma is per connection, so the setting never reaches
 * the connection that needs it. WAL does not fix it either: WAL allows one
 * writer alongside many readers, and this is many writers. Measured, both.
 *
 * So the queue is the fix, and it is the honest one — SQLite permits a single
 * writer, and waiting for a turn is what `busy_timeout` would have done had it
 * been reachable. Serialized, the same 40 writes all succeed.
 */
function serializeWrites(client: Client): Client {
  let tail: Promise<unknown> = Promise.resolve();

  // Patched in place rather than wrapped in a new object. The client is a class
  // with private fields, and a prototype-chained copy loses access to them —
  // every call fails with "Receiver must be an instance of".
  const original = client.transaction.bind(client);

  client.transaction = (async (mode?: unknown) => {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ahead = tail;
    tail = tail.then(() => mine, () => mine);
    await ahead.catch(() => undefined);

    let transaction;
    try {
      transaction = await (original as (m?: unknown) => Promise<unknown>)(mode);
    } catch (error) {
      // Never leave the queue holding a lock nobody owns.
      release();
      throw error;
    }

    const tx = transaction as {
      commit(): Promise<void>;
      rollback(): Promise<void>;
      close(): void;
    };
    const commit = tx.commit.bind(tx);
    const rollback = tx.rollback.bind(tx);
    const close = tx.close.bind(tx);

    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };

    tx.commit = async () => {
      try {
        await commit();
      } finally {
        releaseOnce();
      }
    };
    tx.rollback = async () => {
      try {
        await rollback();
      } finally {
        releaseOnce();
      }
    };
    tx.close = () => {
      try {
        close();
      } finally {
        releaseOnce();
      }
    };

    return transaction;
  }) as Client['transaction'];

  return client;
}

/**
 * Foreign keys are off by default in SQLite and have to be enabled per
 * connection. Every connection this package hands out goes through here, so a
 * reference to a row that does not exist fails immediately rather than sitting
 * in the database as a dangling id.
 */
export async function enforceIntegrity(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');

  // Write-ahead logging lets readers run alongside the single writer, so a
  // leaderboard read does not queue behind a trade. It is a property of the
  // file and persists, but is set explicitly rather than left to the driver's
  // default, because the whole read story depends on it. libsql ignores it for
  // an in-memory database, which is what tests use.
  await client.execute('PRAGMA journal_mode = WAL');

  // A bare write that lands while a transaction holds the writer lock fails
  // instantly without this, and 500s the request that issued it. With it the
  // write waits its short turn instead. It reaches this shared connection even
  // though it never reaches the separate connection a transaction is given —
  // which is why the write queue in openDatabase exists as well, not instead.
  await client.execute('PRAGMA busy_timeout = 5000');
}
