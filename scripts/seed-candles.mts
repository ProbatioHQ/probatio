/**
 * Backfill a real token's chart into the local database.
 *
 * Used to bring a development database to life, and the same path step 23
 * relies on so the app is never shown empty.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/seed-candles.ts <mint>
 */
import { RpcClient, bondingCurveAddress } from '@probatio/pools';
import { backfillFromCurve, buildCandles, TIMEFRAMES, type Timeframe } from '@probatio/candles';
import { migrate, openDatabase, recordBackfill, writeCandles } from '@probatio/db';

const mint = process.argv[2];
if (!mint) {
  console.error('usage: tsx scripts/seed-candles.ts <mint>');
  process.exit(1);
}

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const rpcUrl = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const maxTransactions = Number(process.env['MAX_TXS'] ?? '80');

const db = openDatabase({ url });
await migrate(db);

const rpc = new RpcClient({
  endpoint: rpcUrl,
  timeoutMs: 30_000,
  minIntervalMs: 110,
  maxRetries: 6,
});

console.log(`reading ${mint} from chain…`);
const result = await backfillFromCurve(rpc, mint, bondingCurveAddress(mint), {
  maxTransactions,
  concurrency: 2,
});

console.log(
  `  ${result.observations.length} observations from ${result.transactionsScanned} transactions` +
    `${result.truncated ? ' (truncated)' : ''}`,
);

if (result.observations.length === 0) {
  console.log('nothing to write');
  process.exit(0);
}

for (const timeframe of Object.keys(TIMEFRAMES) as Timeframe[]) {
  const candles = buildCandles(result.observations, timeframe);
  await writeCandles(
    db,
    mint,
    timeframe,
    candles.map((candle) => ({
      openTime: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volumeLamports: candle.volumeLamports,
      trades: candle.trades,
    })),
  );
  console.log(`  ${timeframe.padEnd(3)} ${candles.length} candles`);
}

const times = result.observations.map((observation) => observation.timestamp);
await recordBackfill(
  db,
  {
    mint,
    oldestTimestamp: Math.min(...times),
    newestTimestamp: Math.max(...times),
    observations: result.observations.length,
    truncated: result.truncated,
  },
  Date.now(),
);

console.log('done');
