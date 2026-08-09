/**
 * Do people come back.
 *
 * A script rather than an endpoint. These numbers are for whoever is building
 * the thing, and an endpoint would need auth, a role, and a page — three things
 * to get wrong in exchange for a number that can be read from a terminal.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/retention.mts
 */
import { allActivity, migrate, openDatabase } from '@probatio/db';
import { cohorts, dayNumber, dayString, summarize } from '@probatio/retention';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';

const db = openDatabase({ url });
await migrate(db);

const rows = await allActivity(db);
if (rows.length === 0) {
  console.log('no activity recorded yet');
  process.exit(0);
}

const today = dayNumber(Date.now());
const list = cohorts(
  rows.map((row) => ({ pubkey: row.userPubkey, day: row.day, traded: row.traded })),
  { today },
);
const summary = summarize(list, today);

const pct = (bps: number | null): string => (bps === null ? '  —  ' : `${(bps / 100).toFixed(1)}%`.padStart(5));

console.log('Cohorts\n');
console.log('date        joined  traded   d1     d2     d3     d7');
for (const cohort of list) {
  const cells = [1, 2, 3, 7].map((offset) => pct(cohort.returnBps[offset] ?? null));
  console.log(
    `${dayString(cohort.day)}  ${String(cohort.size).padStart(6)}  ${String(cohort.activated).padStart(6)}  ${cells.join('  ')}`,
  );
}

console.log('\nOverall');
console.log(`  wallets seen        ${summary.wallets}`);
console.log(`  ever traded         ${summary.activated}  (${pct(summary.activationBps).trim()})`);
console.log(`  came back next day  ${pct(summary.d1Bps).trim()}`);
console.log(`  came back day 2     ${pct(summary.d2Bps).trim()}`);
console.log(`  came back day 7     ${pct(summary.d7Bps).trim()}`);

// Said out loud, because a day-7 number resting on one cohort is a number
// about one day, and it will be quoted as though it were about the product.
console.log(`\n  the day 7 figure rests on ${summary.maturedCohorts} cohort(s) old enough to have reached it`);

if (summary.maturedCohorts === 0) {
  console.log('  nothing has reached day 7 yet — that figure is not yet a measurement');
}
