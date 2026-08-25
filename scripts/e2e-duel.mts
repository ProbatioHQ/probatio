/**
 * The duel path end to end, against a real database file.
 *
 * The unit tests cover the rules in memory. What this checks is what they
 * cannot: that offering, accepting and settling works against a database that
 * has been through every migration in order, with accounts holding real
 * balances, and produces the return the arithmetic says it should.
 *
 * Needs a database with a ranked season already open as id 1:
 *
 *   DATABASE_URL=file:./duel.db npx tsx scripts/open-season.mts --free
 *   DATABASE_URL=file:./duel.db npx tsx scripts/e2e-duel.mts
 *
 * Writes to whatever DATABASE_URL points at, so point it at a scratch copy
 * rather than anything anybody is using.
 */
import {
  acceptDuel, dueDuels, ensureAccount, migrate, offerDuel, openDatabase,
  returnBps, settleDuel, duelRecord, liveDuelFor,
} from '@probatio/db';

const url = process.env['DATABASE_URL']!;
const db = openDatabase({ url });
await migrate(db);

const A = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const B = '4Nd1mQ6vFvBmMSAcCEHSKm3StTLvNCTLnFXQyBnGZAaB';
const now = Date.now();

for (const pubkey of [A, B]) {
  await db.execute({ sql: 'INSERT OR IGNORE INTO users (pubkey, created_at) VALUES (?, ?)', args: [pubkey, now] });
}

const alice = await ensureAccount(db, 1, A, now);
const bob = await ensureAccount(db, 1, B, now);
console.log('accounts', alice.id, bob.id, 'balance', alice.solBalance);

const duel = await offerDuel(db, { seasonId: 1, challenger: A, opponent: B, windowSeconds: 3_600 }, now);
console.log('offered   ', duel.id, duel.status);

const live = await acceptDuel(db, {
  id: duel.id, opponent: B,
  challengerOpen: BigInt(alice.solBalance),
  opponentOpen: BigInt(bob.solBalance),
  unpriced: 0,
}, now);
console.log('live      ', live.status, 'ends in', (live.endsAt! - now) / 1000, 's');
console.log('locked    ', (await liveDuelFor(db, A))?.id === live.id);

// Nothing due until the window closes.
console.log('due now   ', (await dueDuels(db, now)).length, '(want 0)');
console.log('due after ', (await dueDuels(db, live.endsAt!)).length, '(want 1)');

// Alice ends up 3% ahead, Bob 1% down.
const open = BigInt(alice.solBalance);
const aClose = (open * 10_300n) / 10_000n;
const bClose = (open * 9_900n) / 10_000n;

const settled = await settleDuel(db, {
  id: live.id, challengerClose: aClose, opponentClose: bClose, unpriced: 0,
}, live.endsAt!);

console.log('settled   ', settled!.status);
console.log('challenger', settled!.challengerBps, 'bps (want 300)');
console.log('opponent  ', settled!.opponentBps, 'bps (want -100)');
console.log('winner    ', settled!.winner === A ? 'challenger' : settled!.winner === B ? 'opponent' : 'draw');
console.log('seal      ', settled!.seal?.slice(0, 16));
console.log('record A  ', JSON.stringify(await duelRecord(db, A)));
console.log('record B  ', JSON.stringify(await duelRecord(db, B)));
console.log('freed     ', (await liveDuelFor(db, A)) === null);
console.log('idempotent', (await settleDuel(db, { id: live.id, challengerClose: 1n, opponentClose: 9n, unpriced: 0 }, now)) === null);
console.log('sanity    ', returnBps(open, aClose) === 300);
