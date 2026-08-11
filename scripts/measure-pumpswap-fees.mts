/**
 * What a PumpSwap buy actually costs, split by where the SOL goes.
 *
 *   npx tsx scripts/measure-pumpswap-fees.mts <mint> [samples]
 *
 * The engine quotes graduated tokens with PUMPSWAP_DEFAULT_FEES, which is a
 * byte-for-byte copy of the bonding curve's schedule: protocol 95, creator 30,
 * LP 0. The curve's numbers are verified exactly by the mainnet replay harness.
 * PumpSwap's have never been measured at all, and this is the tool that does it.
 *
 * Method. For a buy, every WSOL balance change in the transaction is read: what
 * reached the pool vault, and what reached anything else. Then the SOL the
 * constant product was actually run against is recovered from the token output,
 *
 *   tokensOut = tokenReserve - k / (solReserve + effective)
 *
 * so the shortfall between what entered the vault and `effective` is the LP fee
 * the pool kept, and the shortfall against the gross is the total cost.
 *
 * What it refuses to score, because a wrong number here would be worse than no
 * number:
 *
 * - Router hops. A transaction that moves WSOL through unrelated accounts would
 *   count that as fees. Anything above a tenth of the trade is dropped.
 * - Liquidity operations. A deposit moves both vaults the same way; only a swap
 *   moves them in opposite directions. Counting a deposit as a swap attributes
 *   the whole deposit to fees, which is what first produced a reading of 90%.
 *
 * Known limit: balances are transaction-level, so a transaction containing more
 * than one swap on this pool is solved as though it were one and will read as
 * nonsense. Small, newly graduated tokens are mostly traded in bundles like
 * that, so the readings that survive are from liquid pools. Treat a result from
 * a thin pool as unmeasured rather than as a fee.
 */
import { PoolReader, RpcClient } from '@probatio/pools';

const endpoint = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const mint = process.argv[2]!;
const want = Number(process.argv[3] ?? '8');
const WSOL = 'So11111111111111111111111111111111111111112';

const rpc = new RpcClient({ endpoint, timeoutMs: 30_000, minIntervalMs: 220 });
const reader = new PoolReader(rpc);
const pools = await reader.findPumpSwapPools(mint);
const pool = await reader.deepestPool(pools);
if (!pool) { console.error('no pool'); process.exit(1); }

async function call(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (response.status === 429) { await new Promise((r) => setTimeout(r, 2_500)); continue; }
    const body = (await response.json()) as any;
    if (body.error?.code === -32429) { await new Promise((r) => setTimeout(r, 2_500)); continue; }
    return body;
  }
  return { error: 'rate limited' };
}

const signatures = (await call('getSignaturesForAddress', [pool.address, { limit: 60 }])).result ?? [];
console.log(`pool ${pool.address}\n`);

let done = 0;
const totals: number[] = [];
const lpShares: number[] = [];

for (const entry of signatures) {
  if (done >= want) break;
  if (entry.err) continue;

  const tx = (await call('getTransaction', [entry.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }])).result;
  if (!tx?.meta) continue;

  // Every WSOL movement in the transaction, from the token balance deltas.
  const keys = tx.transaction.message.accountKeys.map((k: any) => (typeof k === 'string' ? k : k.pubkey));
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.mint === WSOL) pre.set(keys[b.accountIndex], BigInt(b.uiTokenAmount.amount));
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint === WSOL) post.set(keys[b.accountIndex], BigInt(b.uiTokenAmount.amount));
  }

  const deltas: { account: string; delta: bigint }[] = [];
  for (const account of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(account) ?? 0n) - (pre.get(account) ?? 0n);
    if (delta !== 0n) deltas.push({ account, delta });
  }

  const toPool = deltas.find((d) => d.account === pool!.pool.quoteVault);
  if (!toPool || toPool.delta <= 0n) continue; // buys only

  // A swap moves the two vaults in opposite directions. A liquidity deposit
  // moves both the same way, and counting one as a swap attributes the whole
  // deposit to fees — which is what produced 90% "fees" on a small pool.
  const baseDelta = (() => {
    const preB = (tx.meta.preTokenBalances ?? []).find((b: any) => keys[b.accountIndex] === pool!.pool.baseVault);
    const postB = (tx.meta.postTokenBalances ?? []).find((b: any) => keys[b.accountIndex] === pool!.pool.baseVault);
    if (!preB || !postB) return 0n;
    return BigInt(postB.uiTokenAmount.amount) - BigInt(preB.uiTokenAmount.amount);
  })();
  if (baseDelta >= 0n) continue;

  // Everything that gained WSOL other than the pool is a fee recipient.
  const fees = deltas.filter((d) => d.delta > 0n && d.account !== pool!.pool.quoteVault);
  const feeTotal = fees.reduce((sum, f) => sum + f.delta, 0n);
  // A router hop moves WSOL through accounts that are not fees at all. A real
  // fee is a small fraction of the trade; anything above a tenth means this
  // transaction did more than swap here, and it is dropped rather than guessed
  // at. Being strict is what made the curve figure worth anything.
  if (feeTotal * 10n > toPool.delta) continue;
  const gross = toPool.delta + feeTotal;
  if (gross <= 0n) continue;

  // The in-pool share, recovered from the constant product shortfall.
  const preBase = (tx.meta.preTokenBalances ?? []).find((b: any) => keys[b.accountIndex] === pool!.pool.baseVault);
  const postBase = (tx.meta.postTokenBalances ?? []).find((b: any) => keys[b.accountIndex] === pool!.pool.baseVault);
  const preQuote = (tx.meta.preTokenBalances ?? []).find((b: any) => keys[b.accountIndex] === pool!.pool.quoteVault);
  if (!preBase || !postBase || !preQuote) continue;

  const tokBefore = BigInt(preBase.uiTokenAmount.amount);
  const tokAfter = BigInt(postBase.uiTokenAmount.amount);
  const solBefore = BigInt(preQuote.uiTokenAmount.amount);
  const tokensOut = tokBefore - tokAfter;

  // Solve for the SOL the curve was actually run against:
  //   tokensOut = tokBefore - k / (solBefore + effective)
  const k = solBefore * tokBefore;
  const effective = k / (tokBefore - tokensOut) - solBefore;
  const lpKept = toPool.delta - effective;

  const totalFeeBps = Number(((gross - effective) * 10_000n) / gross);
  const lpBps = Number((lpKept * 10_000n) / gross);
  const outsideBps = Number((feeTotal * 10_000n) / gross);

  totals.push(totalFeeBps);
  lpShares.push(lpBps);

  console.log(`buy ${entry.signature.slice(0, 12)}…`);
  console.log(`  gross in        ${gross}`);
  console.log(`  to pool vault   ${toPool.delta}`);
  console.log(`  fee accounts    ${fees.length} → ${feeTotal}`);
  console.log(`  priced against  ${effective}   (LP kept ${lpKept})`);
  console.log(`  total fee ${totalFeeBps} bps  =  ${outsideBps} outside + ${lpBps} in pool`);
  done += 1;
}

const median = (list: number[]) => { const s = [...list].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
console.log(`\nmedian total fee: ${median(totals)} bps   (engine charges 125)`);
console.log(`median LP share:  ${median(lpShares)} bps   (engine models 0)`);
