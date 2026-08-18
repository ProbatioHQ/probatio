import 'server-only';
import { restoreAccountsIfEmpty } from './account-backup';
import { migrate, openDatabase, type Client } from '@probatio/db';
import { databaseUrl } from './env';
import { reclaimIfTight, recoverIfCorrupt } from './db-reclaim';

/**
 * One connection per process, opened lazily.
 *
 * Migrations run on first use rather than at import time so that building the
 * app does not require a reachable database.
 */
let client: Client | undefined;
let ready: Promise<void> | undefined;
let reclaimed: Promise<void> | undefined;
let corruptChecked: Promise<void> | undefined;

export async function db(): Promise<Client> {
  // Before the shared connection opens, give a nearly-full disk its room back.
  // Runs at most once, and returns at once unless the disk is genuinely tight,
  // so the common path pays nothing. It must finish before the connection opens
  // because it rewrites the file the connection would hold open.
  reclaimed ??= reclaimIfTight().catch((error) => {
    console.error('[db] disk reclaim failed', error);
  });
  await reclaimed;

  // A corrupt database is set aside and rebuilt fresh, so a damaged file heals
  // itself on the next boot rather than failing every query that touches it.
  corruptChecked ??= recoverIfCorrupt().catch((error) => {
    console.error('[db] corruption recovery failed', error);
  });
  await corruptChecked;

  client ??= openDatabase({ url: databaseUrl() });
  const opened = client;
  /*
   * Migrate, then put the accounts back if the file came up without them.
   *
   * Chained onto the same promise every caller already waits on, so nothing
   * reads an account before the restore has had its turn. It does nothing at
   * all when the database has accounts on it, which is every ordinary boot.
   */
  /*
   * A failed start is retried, not remembered.
   *
   * This promise is shared by every caller, so a rejection is kept and handed
   * to all of them for the life of the process: a volume that was full for the
   * one moment this ran left every request failing long after there was room
   * again. Cleared on failure so the next caller tries afresh.
   */
  ready ??= migrate(opened)
    .then(() => restoreAccountsIfEmpty(opened))
    .then(() => undefined)
    .catch((error) => {
      ready = undefined;
      throw error;
    });
  await ready;
  return opened;
}
