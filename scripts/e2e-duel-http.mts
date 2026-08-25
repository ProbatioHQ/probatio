/**
 * The duel path over real HTTP, with two real wallets and real signatures.
 *
 * `scripts/e2e-duel.mts` proves the arithmetic against a database. This proves
 * the thing that one cannot: that the routes people actually reach behave, with
 * sessions issued by the real sign-in flow and every check on the way in doing
 * its job. Sign in, offer, accept, read the live score, settle, read the result.
 *
 * The one thing it seeds directly is the season entry. Entering runs a sybil
 * assessment against the chain, and a keypair generated a second ago is exactly
 * what that is built to refuse, so a throwaway wallet can never enter over HTTP.
 * That check is not what this is testing; everything after it is.
 *
 *   DATABASE_URL=file:./duel.db npx tsx scripts/open-season.mts --free
 *   BASE=http://localhost:3311 DATABASE_URL=file:./duel.db \
 *     npx tsx scripts/e2e-duel-http.mts
 *
 * Writes to whatever DATABASE_URL points at. Point it at a scratch copy.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { migrate, openDatabase } from '@probatio/db';

const BASE = process.env['BASE'] ?? 'http://localhost:3311';
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is required');

const db = openDatabase({ url });
await migrate(db);

const season = await db.execute('SELECT id, ends_at FROM seasons WHERE ranked = 1 ORDER BY ordinal DESC LIMIT 1');
const seasonId = Number(season.rows[0]!['id']);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

interface Wallet {
  readonly pubkey: string;
  readonly secret: Uint8Array;
  cookie: string;
}

function wallet(): Wallet {
  const secret = ed25519.utils.randomSecretKey();
  const pubkey = bs58.encode(ed25519.getPublicKey(secret));
  return { pubkey, secret, cookie: '' };
}

/** Sign in the way a wallet does: ask for a challenge, sign it, present it. */
async function signIn(w: Wallet): Promise<void> {
  const nonceResponse = await fetch(`${BASE}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey: w.pubkey }),
  });
  const { nonce, message } = (await nonceResponse.json()) as { nonce: string; message: string };

  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), w.secret));
  const verify = await fetch(`${BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey: w.pubkey, nonce, signature }),
  });
  if (!verify.ok) throw new Error(`sign-in failed: ${await verify.text()}`);
  w.cookie = (verify.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .join('; ');
  if (!w.cookie) throw new Error('no session cookie came back');
}

const call = (w: Wallet, path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: w.cookie, ...(init.headers ?? {}) },
  });

const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });

// ---------------------------------------------------------------------------

const alice = wallet();
const bob = wallet();
const cara = wallet();

console.log('\nsigning in three wallets');
for (const w of [alice, bob, cara]) await signIn(w);
check('three sessions issued', [alice, bob, cara].every((w) => w.cookie !== ''));

/*
 * The entry, seeded. See the note at the top: the sybil check refuses a wallet
 * created moments ago, which is the whole point of it.
 */
for (const w of [alice, bob, cara]) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO entries (season_id, user_pubkey, entered_at)
          VALUES (?, ?, ?)`,
    args: [seasonId, w.pubkey, Date.now()],
  });
}

console.log('\noffering');
{
  const { status, body } = await json(
    await call(alice, '/api/duel', {
      method: 'POST',
      body: JSON.stringify({ opponent: bob.pubkey, windowSeconds: 3600 }),
    }),
  );
  check('alice can offer bob a duel', status === 200, JSON.stringify(body));

  const self = await json(
    await call(alice, '/api/duel', {
      method: 'POST',
      body: JSON.stringify({ opponent: alice.pubkey, windowSeconds: 3600 }),
    }),
  );
  check('cannot duel yourself', self.status === 400, self.body.error);

  const badWindow = await json(
    await call(alice, '/api/duel', {
      method: 'POST',
      body: JSON.stringify({ opponent: cara.pubkey, windowSeconds: 47 }),
    }),
  );
  check('refuses an unoffered window', badWindow.status === 400, badWindow.body.error);

  const stranger = await json(
    await call(alice, '/api/duel', {
      method: 'POST',
      body: JSON.stringify({ opponent: 'notatrader', windowSeconds: 3600 }),
    }),
  );
  check('refuses a name nobody holds', stranger.status === 404, stranger.body.error);

  const again = await json(
    await call(alice, '/api/duel', {
      method: 'POST',
      body: JSON.stringify({ opponent: bob.pubkey, windowSeconds: 3600 }),
    }),
  );
  check('refuses a second offer to the same person', again.status === 409, again.body.error);

  const anon = await json(
    await fetch(`${BASE}/api/duel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opponent: bob.pubkey, windowSeconds: 3600 }),
    }),
  );
  check('refuses a signed-out offer', anon.status === 401, anon.body.error);
}

console.log('\nreading it back');
let duelId = 0;
{
  const mine = await json(await call(bob, '/api/duel'));
  const incoming = mine.body.mine.filter((d: any) => d.status === 'offered' && d.iChallenged === false);
  check('bob sees it as incoming', incoming.length === 1);
  check('bob is told which side is his', incoming[0]?.you?.pubkey === bob.pubkey);
  duelId = incoming[0]?.id ?? 0;

  const theirs = await json(await call(alice, '/api/duel'));
  const outgoing = theirs.body.mine.filter((d: any) => d.status === 'offered' && d.iChallenged === true);
  check('alice sees it as outgoing', outgoing.length === 1);
}

console.log('\naccepting');
{
  const wrong = await json(
    await call(cara, '/api/duel', {
      method: 'PATCH',
      body: JSON.stringify({ id: duelId, action: 'accept' }),
    }),
  );
  check('a bystander cannot accept it', wrong.status === 409, wrong.body.error);

  const { status, body } = await json(
    await call(bob, '/api/duel', {
      method: 'PATCH',
      body: JSON.stringify({ id: duelId, action: 'accept' }),
    }),
  );
  check('bob can accept', status === 200, JSON.stringify(body));
  check('the clock is running', typeof body.endsAt === 'number' && body.endsAt > Date.now());

  /*
   * The bug the review pass found. Cara challenges bob, who is now live, and
   * bob accepts. This used to reach the unique index and come back as a five
   * hundred rather than a sentence.
   */
  const second = await json(
    await call(cara, '/api/duel', {
      method: 'POST',
      body: JSON.stringify({ opponent: bob.pubkey, windowSeconds: 3600 }),
    }),
  );
  check('a third party cannot offer to somebody mid-duel', second.status === 409, second.body.error);
}

console.log('\nthe live score');
{
  const { body } = await json(await call(bob, '/api/duel'));
  const live = body.mine.find((d: any) => d.status === 'live');
  check('bob sees a live duel', live !== undefined);
  check('both sides are named', live?.you?.pubkey === bob.pubkey && live?.them?.pubkey === alice.pubkey);
  check('a running score is reported', body.running !== null, JSON.stringify(body.running));
  check('both flat at the open', body.running?.you === 0 && body.running?.them === 0);
}

console.log('\nsettling');
{
  // The window is pushed into the past rather than waited out, and alice is
  // given a better close than bob. Everything else is the real path.
  await db.execute({ sql: 'UPDATE duels SET ends_at = ? WHERE id = ?', args: [Date.now() - 1_000, duelId] });
  await db.execute({
    sql: `UPDATE accounts SET sol_balance = ? WHERE season_id = ? AND user_pubkey = ?`,
    args: ['11000000000', seasonId, alice.pubkey],
  });
  await db.execute({
    sql: `UPDATE accounts SET sol_balance = ? WHERE season_id = ? AND user_pubkey = ?`,
    args: ['9500000000', seasonId, bob.pubkey],
  });

  console.log('  waiting for the settler (it runs every 30s)');
  let settled: any = null;
  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const { body } = await json(await call(alice, '/api/duel'));
    settled = body.mine.find((d: any) => d.id === duelId && d.status === 'settled');
    if (settled) break;
    process.stdout.write('.');
  }
  console.log('');

  check('the settler closed it on its own', settled !== null && settled !== undefined);
  if (settled) {
    check('alice won', settled.winner === alice.pubkey);
    check('alice is +10%', settled.you?.bps === 1_000, String(settled.you?.bps));
    check('bob is −5%', settled.them?.bps === -500, String(settled.them?.bps));
    check('it is sealed', typeof settled.seal === 'string' && settled.seal.length === 64);
    check('and marked fully priced', settled.fullyPriced === true);
  }

  const { body } = await json(await call(alice, '/api/duel'));
  check('alice has a record of one win', body.record?.won === 1 && body.record?.lost === 0);
  check('and is free to duel again', body.running === null);
  check('it is on the public board', body.recent.some((d: any) => d.id === duelId));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} CHECKS FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
