/**
 * Proof that the account safety net puts a balance back.
 *
 * Seeds an account with a balance that is not the opening figure, snapshots it,
 * deletes the account rows the way losing the file did twice, and restores.
 */
process.env['DATABASE_URL'] = 'file:/tmp/probatio-restore-test/probatio.db';
process.env['APP_URI'] = 'http://localhost:3000';
process.env['SESSION_SECRET'] = 'x'.repeat(64);

const { openDatabase, migrate, ensureFreePlaySeason, ensureAccount, upsertUser } = await import(
  '../packages/db/src/index.js'
);
const { snapshotAccounts, restoreAccountsIfEmpty } = await import('../app/lib/account-backup.js');

const db = openDatabase({ url: process.env['DATABASE_URL']! });
await migrate(db);

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const NOW = Date.now();
await upsertUser(db, PUBKEY, NOW);
const seasonId = await ensureFreePlaySeason(db, NOW);
const account = await ensureAccount(db, seasonId, PUBKEY, NOW);
await db.execute({
  sql: 'UPDATE accounts SET sol_balance = ? WHERE id = ?',
  args: ['7250000000', account.id],
});

const balance = async (): Promise<string> => {
  const r = await db.execute('SELECT sol_balance FROM accounts LIMIT 1');
  return r.rows[0] ? String(r.rows[0]['sol_balance']) : 'NO ACCOUNT';
};

console.log('seeded:        ', await balance());
await snapshotAccounts(db);
await db.execute('DELETE FROM positions');
await db.execute('DELETE FROM accounts');
console.log('after wipe:    ', await balance());
await restoreAccountsIfEmpty(db);
const back = await balance();
console.log('after restore: ', back);
console.log(back === '7250000000' ? 'PASS: the balance came back' : 'FAIL');
