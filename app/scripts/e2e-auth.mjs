// End-to-end check of the sign-in flow against a running dev server.
//
// Acts as a wallet: generates a keypair, signs the challenge, redeems it. This
// covers what unit tests cannot — cookie flags, status codes, and whether the
// routes are actually wired together.
//
// Run `npm run dev` first, then from the repo root:
//   BASE=http://localhost:3000 node app/scripts/e2e-auth.mjs
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

const BASE = process.env.BASE ?? 'http://localhost:3000';

const secretKey = ed25519.utils.randomSecretKey();
const publicKey = ed25519.getPublicKey(secretKey);
const address = bs58.encode(publicKey);

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function getChallenge(pubkey = address) {
  const res = await fetch(`${BASE}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey }),
  });
  return { res, body: await res.json() };
}

function sign(message, key = secretKey) {
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), key));
}

async function verify(payload) {
  const res = await fetch(`${BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json() };
}

console.log(`\nwallet ${address}\n`);

console.log('challenge issuance');
{
  const { res, body } = await getChallenge();
  check('returns 200', res.status === 200, `got ${res.status}`);
  check('includes a nonce', typeof body.nonce === 'string');
  check('message names the wallet', body.message?.includes(address));
  check('message names the domain', body.message?.includes('localhost:3000'));
  check('message says funds cannot move', body.message?.includes('cannot move your funds'));
}

console.log('\nrejects a bad address');
{
  const { res } = await getChallenge('not-a-wallet');
  check('returns 400', res.status === 400, `got ${res.status}`);
}

console.log('\nhappy path');
let sessionCookie = null;
{
  const { body } = await getChallenge();
  const { res, body: verified } = await verify({
    pubkey: address,
    nonce: body.nonce,
    signature: sign(body.message),
  });
  check('returns 200', res.status === 200, `got ${res.status} ${JSON.stringify(verified)}`);
  check('echoes the wallet', verified.pubkey === address);
  sessionCookie = res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie');
  check('sets a session cookie', Boolean(sessionCookie));
  check('cookie is httpOnly', /httponly/i.test(sessionCookie ?? ''));
  check('cookie is sameSite lax', /samesite=lax/i.test(sessionCookie ?? ''));
}

console.log('\nsession is readable');
{
  const res = await fetch(`${BASE}/api/auth/session`, {
    headers: { cookie: sessionCookie.split(';')[0] },
  });
  const body = await res.json();
  check('returns the signed-in wallet', body.pubkey === address, JSON.stringify(body));
}

console.log('\nsession rejects a forged cookie');
{
  const [name, value] = sessionCookie.split(';')[0].split('=');
  const tampered = `${name}=${value.slice(0, -3)}aaa`;
  const res = await fetch(`${BASE}/api/auth/session`, { headers: { cookie: tampered } });
  const body = await res.json();
  check('reports signed out', body.pubkey === null, JSON.stringify(body));
}

console.log('\nnonce cannot be replayed');
{
  const { body } = await getChallenge();
  const signature = sign(body.message);
  await verify({ pubkey: address, nonce: body.nonce, signature });
  const { res } = await verify({ pubkey: address, nonce: body.nonce, signature });
  check('second redemption returns 401', res.status === 401, `got ${res.status}`);
}

console.log('\nwrong key cannot redeem');
{
  const other = ed25519.utils.randomSecretKey();
  const { body } = await getChallenge();
  const { res, body: err } = await verify({
    pubkey: address,
    nonce: body.nonce,
    signature: sign(body.message, other),
  });
  check('returns 401', res.status === 401, `got ${res.status}`);
  check('reports a bad signature', err.code === 'bad_signature', JSON.stringify(err));
}

console.log('\nnonce is spent even by a failed attempt');
{
  const other = ed25519.utils.randomSecretKey();
  const { body } = await getChallenge();
  await verify({ pubkey: address, nonce: body.nonce, signature: sign(body.message, other) });
  const { res } = await verify({
    pubkey: address,
    nonce: body.nonce,
    signature: sign(body.message),
  });
  check('correct signature afterwards still fails', res.status === 401, `got ${res.status}`);
}

console.log('\nsigning a different message does not work');
{
  const { body } = await getChallenge();
  const tamperedMessage = body.message.replace(/Nonce: .+/, 'Nonce: something-else');
  const { res } = await verify({
    pubkey: address,
    nonce: body.nonce,
    signature: sign(tamperedMessage),
  });
  check('returns 401', res.status === 401, `got ${res.status}`);
}

console.log('\nlogout');
{
  const res = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: sessionCookie.split(';')[0] },
  });
  check('returns 200', res.status === 200, `got ${res.status}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
