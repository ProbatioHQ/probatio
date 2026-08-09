// Walks the path a new arrival takes: land, browse, sign in, trade, and watch
// the guide disappear. Needs `npm run dev`.
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const BASE = process.env.BASE ?? 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l} ${d}`)); };
const json = async (p, init) => (await fetch(`${BASE}${p}`, init)).json();

console.log('\narriving with no wallet');
const anon = await json('/api/onboarding');
check('the guide starts at step one', anon.signedIn === false && anon.done === false);

const feed = await json('/api/launches');
check('the feed works without signing in', Array.isArray(feed.launches));
check('there is something to look at', feed.launches.length > 0, String(feed.launches.length));
check('launches carry a name and symbol', Boolean(feed.launches[0]?.symbol && feed.launches[0]?.name));
console.log(`    ${feed.launches.length} tokens, newest ${feed.launches[0]?.symbol}`);

console.log('\nsearching');
const bySymbol = await json('/api/launches?q=wCATE');
check('finds a token by symbol', bySymbol.launches.some((l) => l.symbol === 'wCATE'));
const byName = await json('/api/launches?q=Toad');
check('finds a token by name', byName.launches.some((l) => l.name.includes('Toad')));
const byMint = await json('/api/launches?q=3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump');
check('a pasted mint returns just that token', byMint.launches.length === 1);
const nothing = await json('/api/launches?q=zzzzzznope');
check('an unknown search returns nothing rather than everything', nothing.launches.length === 0);

console.log('\nthe home page renders for a stranger');
const home = await fetch(`${BASE}/`);
const html = await home.text();
check('home responds', home.status === 200);
check('explains what the product is', html.includes('practice money'));
check('says the record cannot be edited', html.includes('cannot be edited'));

console.log('\nsigning in');
const sk = ed25519.utils.randomSecretKey();
const addr = bs58.encode(ed25519.getPublicKey(sk));
const ch = await json('/api/auth/nonce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey: addr }) });
const vr = await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey: addr, nonce: ch.nonce, signature: bs58.encode(ed25519.sign(new TextEncoder().encode(ch.message), sk)) }) });
const cookie = (vr.headers.getSetCookie?.()[0] ?? vr.headers.get('set-cookie')).split(';')[0];

const afterSignIn = await json('/api/onboarding', { headers: { cookie } });
check('the guide advances', afterSignIn.signedIn === true);
check('but is not finished', afterSignIn.done === false);
check('no trades yet', afterSignIn.tradeCount === 0);

console.log('\nfirst trade');
const trade = await json('/api/trade', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ mint: '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump', side: 'buy', size: '500000000', slippageBps: 5000 }),
});

if (trade.status === 'filled') {
  check('the trade fills', true);
  const done = await json('/api/onboarding', { headers: { cookie } });
  check('the guide is finished', done.done === true);
  check('and stays finished', (await json('/api/onboarding', { headers: { cookie } })).done === true);
} else {
  console.log(`  trade rejected: ${trade.reason} — rerun if the market moved`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
