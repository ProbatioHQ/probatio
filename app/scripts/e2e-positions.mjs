import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
const BASE = 'http://localhost:3000';
const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
let pass=0, fail=0;
const check=(l,ok,d='')=>{ok?(pass++,console.log(`  ok   ${l}`)):(fail++,console.log(`  FAIL ${l} ${d}`));};

const sk = ed25519.utils.randomSecretKey();
const addr = bs58.encode(ed25519.getPublicKey(sk));
const ch = await (await fetch(`${BASE}/api/auth/nonce`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pubkey:addr})})).json();
const vr = await fetch(`${BASE}/api/auth/verify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pubkey:addr,nonce:ch.nonce,signature:bs58.encode(ed25519.sign(new TextEncoder().encode(ch.message),sk))})});
const cookie=(vr.headers.getSetCookie?.()[0]??vr.headers.get('set-cookie')).split(';')[0];
const get=async p=>(await fetch(`${BASE}${p}`,{headers:{cookie}})).json();
const trade=async(side,size)=>(await fetch(`${BASE}/api/trade`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({mint:MINT,side,size,slippageBps:5000})})).json();

console.log('\nfresh account');
let p = await get('/api/positions');
check('starts at the starting balance', p.equity.equity === '10000000000', p.equity.equity);
check('starts flat', p.equity.returnBps === 0);
check('no open positions', p.positions.length === 0);
check('trade log empty', (await get('/api/trades')).trades.length === 0);

console.log('\nafter buying 1 SOL');
const buy = await trade('buy','1000000000');
if (buy.status !== 'filled') { console.log('  buy rejected:', buy.reason); process.exit(1); }
p = await get('/api/positions');
check('one open position', p.positions.length === 1);
check('cash dropped', p.equity.cash === '9000000000', p.equity.cash);
check('position is valued', p.positions[0].value !== null);
check('position has a live price', p.positions[0].price !== null);
check('equity counts the position', BigInt(p.equity.equity) > BigInt(p.equity.cash));
check('unrealized is negative right after buying', BigInt(p.equity.unrealized) < 0n, p.equity.unrealized);
check('return is negative', p.equity.returnBps < 0, String(p.equity.returnBps));
console.log(`    equity ${p.equity.equity} return ${(p.equity.returnBps/100).toFixed(2)}%`);

console.log('\ntrade log');
const t = await get('/api/trades');
check('records the buy', t.trades.length === 1);
check('carries a leaf hash', /^[0-9a-f]{64}$/.test(t.trades[0].leafHash), t.trades[0].leafHash);
check('records the latency', t.trades[0].latencyMs === 600);

console.log('\nafter selling everything');
const sell = await trade('sell', p.positions[0].tokenAmount);
if (sell.status === 'filled') {
  p = await get('/api/positions');
  check('position closed', p.positions.length === 0);
  check('unrealized back to zero', p.equity.unrealized === '0', p.equity.unrealized);
  check('realized is now negative', BigInt(p.equity.realized) < 0n, p.equity.realized);
  check('equity equals cash', p.equity.equity === p.equity.cash);
  check('realized explains the whole loss', p.equity.realized === p.equity.totalPnl, `${p.equity.realized} vs ${p.equity.totalPnl}`);
  console.log(`    realized ${p.equity.realized} total ${p.equity.totalPnl} return ${(p.equity.returnBps/100).toFixed(2)}%`);
} else { console.log('  sell rejected:', sell.reason); }

console.log('\nguards');
const anon = await (await fetch(`${BASE}/api/positions`)).json();
check('positions need a session', Boolean(anon.error));
const anonT = await (await fetch(`${BASE}/api/trades`)).json();
check('trades need a session', Boolean(anonT.error));
const bad = await (await fetch(`${BASE}/api/trades?mint=nope`,{headers:{cookie}})).json();
check('rejects a bad mint filter', Boolean(bad.error));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);
