/**
 * Replay a graduated token's real swaps through the fill engine.
 *
 *   npx tsx scripts/replay-pumpswap.mts <mint> [transactions]
 *
 * The counterpart to the curve harness in packages/validation/test/mainnet.ts,
 * for the venue a token trades on after it graduates — which nothing measured
 * until now, and which is how a fee schedule copied from the curve sat wrong by
 * four times without anything noticing.
 *
 * A large error here is as likely to be the harness as the engine. Three things
 * produced one during its own construction, all of them fixed and all of them
 * tested: counting a front end's cut as the venue's fee, reading a liquidity
 * deposit as a swap, and solving an arbitrage that buys and sells in one
 * transaction as a single badly priced trade.
 */
import { PoolReader, RpcClient, pumpSwapReserveOffset } from '@probatio/pools';
import { collectPoolSwaps, replayPool } from '@probatio/validation';
import { totalFeeBps } from '@probatio/sim';

const rpc = new RpcClient({ endpoint: process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com', timeoutMs: 30000, minIntervalMs: 700 });
const reader = new PoolReader(rpc);
const mint = process.argv[2]!;
const max = Number(process.argv[3] ?? '120');

const pools = await reader.findPumpSwapPools(mint);
const pool = await reader.deepestPool(pools);
if (!pool) { console.error('no pool'); process.exit(1); }
const fees = await reader.pumpSwapFees(pool.pool);
const config = await reader.globalConfig();
console.log(`protocol fee recipients: ${config?.protocolFeeRecipients.length}`);
console.log(`pool ${pool.address}   fees ${JSON.stringify(fees)} = ${totalFeeBps(fees)} bps\n`);

const swaps = await collectPoolSwaps(rpc, pool.address, pool.pool, {
  maxTransactions: max,
  concurrency: 1,
  onProgress: (scanned, n) => process.stdout.write(`\r  scanned ${scanned}, swaps ${n}   `),
}, config?.protocolFeeRecipients ?? []);
console.log(`\n${swaps.length} swaps\n`);

const [poolAccount] = await rpc.getAccounts([pool.address]);
const override = process.env['RESERVE_OFFSET'];
const offset = override ? BigInt(override) : poolAccount ? pumpSwapReserveOffset(poolAccount.data) : 0n;
console.log(`quote reserve offset: ${offset}`);
const feeOverride = process.env['FEE_BPS'];
const usedFees = feeOverride
  ? { protocolBps: Number(feeOverride), creatorBps: 0, lpBps: 0 }
  : fees;
const report = replayPool(mint, swaps, 6, 1, usedFees, offset);
console.log(`events seen   ${report.eventsSeen}`);
console.log(`samples       ${report.samples}  (${report.buys} buys, ${report.sells} sells)`);
console.log(`skipped       ${report.skipped.not_consecutive} not consecutive, ${report.skipped.unquotable} unquotable, ${report.skipped.first_event} first`);
console.log(`median error  ${report.medianErrorBps} bps`);
console.log(`p95 error     ${report.p95ErrorBps} bps`);
console.log(`max error     ${report.maxErrorBps} bps`);
console.log(`exact         ${report.exactMatches}/${report.samples}`);
const identical = report.allSamples.filter((x) => x.actual === x.expected).length;
const offByOne = report.allSamples.filter((x) => {
  const d = x.actual - x.expected; return d === 1n || d === -1n;
}).length;
console.log(`identical    ${identical}/${report.samples}   off by one: ${offByOne}`);
for (const w of report.worst.slice(0, 4)) {
  console.log(`  worst ${w.side} ${w.signedErrorBps} bps  engine ${w.actual} vs real ${w.expected}`);
}
