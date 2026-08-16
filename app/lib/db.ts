import 'server-only';
import { migrate, openDatabase, type Client } from '@probatio/db';
import { databaseUrl } from './env';
import { reclaimIfTight } from './db-reclaim';

/**
 * One connection per process, opened lazily.
 *
 * Migrations run on first use rather than at import time so that building the
 * app does not require a reachable database.
 */
let client: Client | undefined;
let ready: Promise<void> | undefined;
let reclaimed: Promise<void> | undefined;

export async function db(): Promise<Client> {
  // Before the shared connection opens, give a nearly-full disk its room back.
  // Runs at most once, and returns at once unless the disk is genuinely tight,
  // so the common path pays nothing. It must finish before the connection opens
  // because it rewrites the file the connection would hold open.
  reclaimed ??= reclaimIfTight().catch((error) => {
    console.error('[db] disk reclaim failed', error);
  });
  await reclaimed;

  client ??= openDatabase({ url: databaseUrl() });
  ready ??= migrate(client).then(() => undefined);
  await ready;
  return client;
}
