/**
 * Fill a fresh install from the live chain.
 *
 * Listens to real pump.fun launches for a short window, records them, and
 * backfills a chart for the busiest few. Everything it writes is read from the
 * chain — nothing is invented, because a leaderboard whose profiles are
 * publicly verifiable cannot afford a single fabricated record.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/bootstrap.mts
 */
import { RpcClient, bondingCurveAddress, PUMP_PROGRAM_ID } from '@probatio/pools';
import { LaunchFeed, LogSubscription, toWebSocketUrl } from '@probatio/feed';
import { backfillFromCurve, buildCandles, TIMEFRAMES, type Timeframe } from '@probatio/candles';
import {
  migrate,
  openDatabase,
  recordBackfill,
  recordLaunches,
  writeCandles,
} from '@probatio/db';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const rpcUrl = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const listenMs = Number(process.env['LISTEN_MS'] ?? '30000');
const chartsFor = Number(process.env['CHARTS'] ?? '3');

const db = openDatabase({ url });
await migrate(db);

const feed = new LaunchFeed();
const collected: Parameters<typeof recordLaunches>[1][number][] = [];

console.log(`listening for launches for ${listenMs / 1000}s…`);

const subscription = new LogSubscription({
  endpoint: toWebSocketUrl(rpcUrl),
  mentions: PUMP_PROGRAM_ID,
  onStatus: (status, detail) => {
    if (status === 'subscribed') console.log('  subscribed');
    if (status === 'error' || (status === 'closed' && detail)) console.log(`  ${status}: ${detail}`);
  },
  onNotification: (notification) => {
    for (const launch of feed.ingest(notification)) {
      collected.push(launch);
      console.log(`  ${launch.symbol.padEnd(12)} ${launch.name}`);
    }
  },
});

subscription.start();
await new Promise((resolve) => setTimeout(resolve, listenMs));
subscription.stop();

const inserted = await recordLaunches(db, collected, Date.now());
console.log(`\n${collected.length} launches seen, ${inserted} recorded`);

if (collected.length === 0) {
  console.log('nothing to chart');
  process.exit(0);
}

// Charts for a few of them, so the first token someone opens is not blank.
const rpc = new RpcClient({
  endpoint: rpcUrl,
  timeoutMs: 30_000,
  minIntervalMs: 110,
  maxRetries: 6,
});

console.log(`\nbackfilling charts for ${Math.min(chartsFor, collected.length)} of them…`);

for (const launch of collected.slice(0, chartsFor)) {
  const result = await backfillFromCurve(rpc, launch.mint, bondingCurveAddress(launch.mint), {
    maxTransactions: 40,
    concurrency: 2,
  });

  if (result.observations.length === 0) {
    console.log(`  ${launch.symbol}: no trades yet`);
    continue;
  }

  for (const timeframe of Object.keys(TIMEFRAMES) as Timeframe[]) {
    const candles = buildCandles(result.observations, timeframe);
    await writeCandles(
      db,
      launch.mint,
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
  }

  const times = result.observations.map((observation) => observation.timestamp);
  await recordBackfill(
    db,
    {
      mint: launch.mint,
      oldestTimestamp: Math.min(...times),
      newestTimestamp: Math.max(...times),
      observations: result.observations.length,
      truncated: result.truncated,
    },
    Date.now(),
  );

  console.log(`  ${launch.symbol}: ${result.observations.length} trades charted`);
}

console.log('\nready');
