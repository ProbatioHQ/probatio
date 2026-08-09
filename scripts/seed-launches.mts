/**
 * Fill the launch feed from chain, for a known set of mints.
 *
 * Each token's CreateEvent is found by walking its bonding curve back to the
 * oldest transaction that touched it, which is its creation.
 *
 * Deliberately not a scan of recent program activity. Creates are a tiny
 * fraction of pump.fun's traffic — forty recent transactions contained none at
 * all — so finding them that way means reading the firehose, which is exactly
 * why the live feed is a websocket subscription rather than polling. This is
 * for filling a development database, not for running the feed.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/seed-launches.mts <mint...>
 */
import { RpcClient, bondingCurveAddress, extractCreateEvents } from '@probatio/pools';
import { migrate, openDatabase, recordLaunches } from '@probatio/db';

const mints = process.argv.slice(2);
if (mints.length === 0) {
  console.error('usage: tsx scripts/seed-launches.mts <mint...>');
  process.exit(1);
}

const db = openDatabase({ url: process.env['DATABASE_URL'] ?? 'file:./app/probatio.db' });
await migrate(db);

const rpc = new RpcClient({
  endpoint: process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
  timeoutMs: 30_000,
  minIntervalMs: 110,
  maxRetries: 6,
});

const found: Parameters<typeof recordLaunches>[1][number][] = [];

for (const mint of mints) {
  const curve = bondingCurveAddress(mint);
  let before: string | undefined;
  let oldest: { signature: string; slot: number } | undefined;

  // Page back until the history runs out; the last signature is the create.
  for (let page = 0; page < 10; page += 1) {
    const signatures = await rpc.getSignatures(curve, {
      limit: 1_000,
      ...(before ? { before } : {}),
    });
    if (signatures.length === 0) break;

    const last = signatures[signatures.length - 1]!;
    oldest = { signature: last.signature, slot: last.slot };
    before = last.signature;
    if (signatures.length < 1_000) break;
  }

  if (!oldest) {
    console.log(`  ${mint} — no history`);
    continue;
  }

  const logs = await rpc.getTransactionLogs(oldest.signature);
  const events = logs ? extractCreateEvents(logs.logMessages) : [];
  const event = events.find((candidate) => candidate.mint === mint);

  if (!event) {
    console.log(`  ${mint} — no create event at its oldest transaction`);
    continue;
  }

  found.push({
    mint: event.mint,
    bondingCurve: event.bondingCurve,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    uri: event.uri,
    launchedAt: event.timestamp,
    slot: oldest.slot,
  });
  console.log(`  ${event.symbol.padEnd(12)} ${event.name}`);
}

const inserted = await recordLaunches(db, found, Date.now());
console.log(`\n${found.length} launches found, ${inserted} new`);
