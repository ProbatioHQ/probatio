import 'server-only';
import { migrate, openDatabase, type Client } from '@probatio/db';
import { databaseUrl } from './env';

/**
 * One connection per process, opened lazily.
 *
 * Migrations run on first use rather than at import time so that building the
 * app does not require a reachable database.
 */
let client: Client | undefined;
let ready: Promise<void> | undefined;

export async function db(): Promise<Client> {
  client ??= openDatabase({ url: databaseUrl() });
  ready ??= migrate(client).then(() => undefined);
  await ready;
  return client;
}
