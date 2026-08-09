import { createClient, type Client, type Config } from '@libsql/client';

export type { Client } from '@libsql/client';

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

  const authToken = config?.authToken ?? process.env['DATABASE_AUTH_TOKEN'];

  return createClient({
    ...config,
    url,
    ...(authToken ? { authToken } : {}),
  });
}

/**
 * Foreign keys are off by default in SQLite and have to be enabled per
 * connection. Every connection this package hands out goes through here, so a
 * reference to a row that does not exist fails immediately rather than sitting
 * in the database as a dangling id.
 */
export async function enforceIntegrity(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');
}
