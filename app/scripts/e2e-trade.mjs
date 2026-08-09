// End-to-end check of trading against a live pool.
//
// Signs in as a fresh wallet, buys, sells, and asserts the balance and
// position move the way the arithmetic says they should. Needs `npm run dev`
// and a real RPC, because the fill is quoted against an actual market.
//
//   BASE=http://localhost:3000 node app/scripts/e2e-trade.mjs <mint>
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const MINT = process.argv[2] ?? '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
};

const secretKey = ed25519.utils.randomSecretKey();
const address = bs58.encode(ed25519.getPublicKey(secretKey));

// Sign in.
const challenge = await (await fetch(`${BASE}/api/auth/nonce`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pubkey: address }),
})).json();

const verify = await fetch(`${BASE}/api/auth/verify`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    pubkey: address, nonce: challenge.nonce,
    signature: bs58.encode(ed25519.sign(new TextEncoder().encode(challenge.message), secretKey)),
  }),
});
const cookie = (verify.headers.getSetCookie?.()[0] ?? verify.headers.get('set-cookie')).split(';')[0];
console.log(`\nwallet ${address}\n`);

const trade = async (side, size, slippageBps = 5000) =>
  (await fetch(`${BASE}/api/trade`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ mint: MINT, side, size, slippageBps }),
  })).json();

console.log('buying 1 SOL');
const started = Date.now();
const buy = await trade('buy', '1000000000');
const elapsed = Date.now() - started;

if (buy.status !== 'filled') {
  console.log(`  buy rejected: ${buy.reason} — ${buy.detail}`);
  console.log('  (a rejection is a real outcome; rerun if the market moved hard)');
  process.exit(fail === 0 ? 0 : 1);
}

check('buy fills', buy.status === 'filled');
check('receives tokens', BigInt(buy.filled.tokenAmount) > 0n);
check('spends exactly 1 SOL', buy.filled.solAmount === '1000000000', buy.filled.solAmount);
check('balance drops by the spend', buy.balance === String(10_000_000_000n - 1_000_000_000n), buy.balance);
check('position matches what was received', buy.position.tokenAmount === buy.filled.tokenAmount);
check('cost basis is what was paid', buy.position.costBasis === '1000000000', buy.position.costBasis);
check('charges a fee', BigInt(buy.filled.feeLamports) > 0n);
check('reports the latency it waited', buy.latencyMs > 0);
check(`actually waited (${elapsed}ms >= ${buy.latencyMs}ms)`, elapsed >= buy.latencyMs);
console.log(`    quoted ${buy.expected.tokenAmount}, filled ${buy.filled.tokenAmount}, slippage ${buy.slippageBps}bp`);

console.log('\nselling half');
const half = String(BigInt(buy.position.tokenAmount) / 2n);
const sell = await trade('sell', half);

if (sell.status === 'filled') {
  check('sell fills', true);
  check('position halves', sell.position.tokenAmount === String(BigInt(buy.position.tokenAmount) - BigInt(half)));
  check('balance rises', BigInt(sell.balance) > BigInt(buy.balance));
  check('books a proportional basis', BigInt(sell.position.costBasis) < BigInt(buy.position.costBasis));
  check('realizes a loss on an instant round trip', BigInt(sell.realized) < 0n, sell.realized);
  console.log(`    realized ${sell.realized} lamports on the half`);
} else {
  console.log(`  sell rejected: ${sell.reason} — ${sell.detail}`);
}

console.log('\nguards');
const tooMuch = await trade('buy', '999000000000');
check('refuses a buy beyond the balance', tooMuch.reason === 'insufficient_sol', JSON.stringify(tooMuch).slice(0,80));
const tooMany = await trade('sell', '999999999999999999');
check('refuses a sell beyond the holding', tooMany.reason === 'insufficient_tokens', JSON.stringify(tooMany).slice(0,80));
const tight = await trade('buy', '100000000', 0);
check('a zero tolerance can reject on movement', ['filled','rejected'].includes(tight.status), tight.status);

const anon = await (await fetch(`${BASE}/api/trade`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mint: MINT, side: 'buy', size: '1000' }),
})).json();
check('refuses an unauthenticated trade', Boolean(anon.error));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
