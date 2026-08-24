/**
 * Fill in the X handle for token metadata written before there was a column.
 *
 * Not required. The server runs the same job itself on start, converging and
 * then stopping, because a script is an instruction to a person and a deploy
 * that forgets one leaves the account-reuse condition quietly wrong.
 *
 * Kept for running it against a database by hand — a restored backup, a local
 * copy — where there is no server to do it.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/backfill-handles.mts
 */
import { backfillTwitterHandles, migrate, openDatabase } from '@probatio/db';

const db = openDatabase({ url: process.env['DATABASE_URL'] ?? 'file:./app/probatio.db' });
await migrate(db);

let total = 0;
for (;;) {
  const written = await backfillTwitterHandles(db, 500);
  if (written === 0) break;
  total += written;
  console.log(`  ${total} handles`);
}
console.log(`done: ${total} rows now carry a handle`);
