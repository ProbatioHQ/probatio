/**
 * What happens when many trades land at once.
 *
 * The interesting failure here is not slowness, it is a broken invariant. Every
 * trade takes a sequence number inside its own write transaction, and a merkle
 * leaf commits to that number — so two trades sharing one, or a gap appearing
 * in the middle of a trader's history, breaks the record rather than the
 * performance.
 *
 * Deliberately not run against a live RPC. A load test that hammers a public
 * endpoint to measure our own code is a load test that gets the endpoint taken
 * away, so this exercises the write path directly.
 *
 *   npx tsx scripts/load-db.mts [concurrency] [tradesEach]
 */
import bs58 from 'bs58';
import { hashLeaf, toHex } from '@probatio/commit';
import { PUMPFUN_CURVE_FEES } from '@probatio/pools';
import {
  createRankedSeason,
  ensureAccount,
  migrate,
  openDatabase,
  recordTrade,
  upsertUser,
} from '@probatio/db';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';

const concurrency = Number(process.argv[2] ?? '25');
const tradesEach = Number(process.argv[3] ?? '20');
const url = process.env['DATABASE_URL'] ?? 'file:/tmp/load.db';

function key(seed: number): string {
  const bytes = new Uint8Array(32);
  let v = (seed * 2_654_435_761) >>> 0;
  for (let i = 0; i < 32; i += 1) {
    v = (v * 1_103_515_245 + 12_345) >>> 0;
    bytes[i] = (v >>> 16) & 0xff;
  }
  return bs58.encode(bytes);
}

const db = openDatabase({ url });
await migrate(db);

const START = 1_770_000_000_000;
const rules = rulesetFor(1);
const schedule = scheduleFrom(START, rules.durationMs, rules.entryWindowMs);

const seasonId = await createRankedSeason(
  db,
  {
    ordinal: 1,
    name: 'Load',
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    entryClosesAt: schedule.entryClosesAt,
    startingBalance: rules.startingBalance.toString(),
    entryCost: rules.entryCost.toString(),
    houseBps: rules.houseBps,
    houseThreshold: rules.houseThreshold.toString(),
    latencyMs: rules.latencyMs,
    maxPriceImpactBps: rules.maxPriceImpactBps,
    engineVersion: rules.engineVersion,
    rulesetHash: rulesetHashHex(rules),
  },
  START,
);

const MINT = key(90_001);
const traders = await Promise.all(
  Array.from({ length: concurrency }, async (_, i) => {
    const pubkey = key(i);
    await upsertUser(db, pubkey, START);
    const account = await ensureAccount(db, seasonId, pubkey, START);
    return { pubkey, accountId: account.id };
  }),
);

const latencies: number[] = [];
const failures: string[] = [];
let slot = 500_000;

async function placeTrade(
  trader: { pubkey: string; accountId: number },
  index: number,
): Promise<void> {
  const mySlot = (slot += 1);
  const solAmount = BigInt(100_000_000 + index * 1_000);
  const tokenAmount = BigInt(50_000 + index * 7);
  const solReserve = BigInt(30_000_000_000 + mySlot);
  const tokenReserve = BigInt(1_000_000_000_000 - mySlot * 1_000);

  const leafBase = {
    seasonOrdinal: 1,
    trader: trader.pubkey,
    mint: MINT,
    side: 'buy' as const,
    solAmount,
    tokenAmount,
    feeLamports: 1_250_000n,
    solReserve,
    tokenReserve,
    deliverableTokens: tokenReserve,
    feeBps: PUMPFUN_CURVE_FEES.protocolBps + PUMPFUN_CURVE_FEES.creatorBps,
    poolSource: 'pumpfun-curve' as const,
    priceImpactBps: 20,
    partial: false,
    clickedAtSlot: mySlot - 1,
    filledAtSlot: mySlot,
    latencyMs: 600,
    engineVersion: 1,
    createdAt: START + mySlot,
  };

  const began = performance.now();
  try {
    await recordTrade(db, {
      snapshot: {
        mint: MINT,
        solReserve: solReserve.toString(),
        tokenReserve: tokenReserve.toString(),
        tokenDecimals: 6,
        feeBps: 125,
        source: 'pumpfun-curve',
        slot: mySlot,
      },
      trade: {
        accountId: trader.accountId,
        seasonId,
        userPubkey: trader.pubkey,
        mint: MINT,
        side: 'buy',
        solAmount: solAmount.toString(),
        tokenAmount: tokenAmount.toString(),
        fee: '1250000',
        priceImpactBps: 20,
        partial: false,
        poolSource: 'pumpfun-curve',
        clickedAtSlot: mySlot - 1,
        filledAtSlot: mySlot,
        latencyMs: 600,
        engineVersion: 1,
      },
      position: {
        accountId: trader.accountId,
        mint: MINT,
        tokenAmount: String(tokenAmount * BigInt(index + 1)),
        costBasis: String(solAmount * BigInt(index + 1)),
        realizedPnl: '0',
        closed: false,
      },
      // Each trade is quoted against what the one before it left behind.
      expected: { solBalance: String(10_000_000_000n - solAmount * BigInt(index)), tokenAmount: null },
      newBalance: String(10_000_000_000n - solAmount * BigInt(index + 1)),
      leafHashFor: (sequence) => toHex(hashLeaf({ ...leafBase, sequence })),
      now: START + mySlot,
    });
    latencies.push(performance.now() - began);
  } catch (error) {
    failures.push(error instanceof Error ? error.message.slice(0, 120) : String(error));
  }
}

console.log(`${concurrency} traders x ${tradesEach} trades, all at once\n`);
const wallBegan = performance.now();

// Every trader's trades fired concurrently, and all traders concurrent with
// each other. Nothing is serialized by the harness, so anything that holds is
// holding because the code makes it hold.
await Promise.all(
  traders.map((trader) =>
    Promise.all(Array.from({ length: tradesEach }, (_, i) => placeTrade(trader, i))),
  ),
);

const wall = performance.now() - wallBegan;
const expected = concurrency * tradesEach;

latencies.sort((a, b) => a - b);
const at = (q: number): string =>
  latencies.length === 0 ? '—' : `${latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))]!.toFixed(0)}ms`;

console.log(`wall clock      ${wall.toFixed(0)}ms`);
console.log(`throughput      ${((latencies.length / wall) * 1000).toFixed(0)} writes/sec`);
console.log(`latency p50     ${at(0.5)}`);
console.log(`latency p95     ${at(0.95)}`);
console.log(`latency p99     ${at(0.99)}`);
console.log(`succeeded       ${latencies.length} of ${expected}`);
console.log(`failed          ${failures.length}`);

if (failures.length > 0) {
  const kinds = new Map<string, number>();
  for (const failure of failures) kinds.set(failure, (kinds.get(failure) ?? 0) + 1);
  console.log('\nfailures:');
  for (const [message, count] of kinds) console.log(`  ${count}x ${message}`);
}

// The invariants. These are what the test is actually for.
console.log('\nInvariants');

const dupes = await db.execute(
  `SELECT account_id, sequence, COUNT(*) AS n FROM trades
   GROUP BY account_id, sequence HAVING n > 1`,
);
console.log(`  duplicate sequences        ${dupes.rows.length}`);

const gaps = await db.execute(
  `SELECT account_id, COUNT(*) AS n, MIN(sequence) AS lo, MAX(sequence) AS hi
   FROM trades GROUP BY account_id`,
);
let gapped = 0;
for (const row of gaps.rows) {
  if (Number(row['lo']) !== 1 || Number(row['hi']) !== Number(row['n'])) gapped += 1;
}
console.log(`  accounts with a gap        ${gapped}`);

const leaves = await db.execute("SELECT COUNT(*) AS n FROM trades WHERE leaf_hash = '' OR leaf_hash IS NULL");
console.log(`  trades missing a leaf      ${leaves.rows[0]!['n']}`);

const snapshots = await db.execute(
  `SELECT COUNT(*) AS n FROM trades t
   LEFT JOIN pool_snapshots p ON p.id = t.pool_snapshot_id WHERE p.id IS NULL`,
);
console.log(`  trades with no snapshot    ${snapshots.rows[0]!['n']}`);

const bad = dupes.rows.length + gapped + Number(leaves.rows[0]!['n']) + Number(snapshots.rows[0]!['n']);
console.log(bad === 0 ? '\nevery invariant held' : `\n${bad} invariant violations`);
process.exit(bad === 0 && failures.length === 0 ? 0 : 1);
