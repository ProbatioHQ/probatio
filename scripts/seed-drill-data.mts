/**
 * Realistic data for the restore drill.
 *
 * A drill on an empty database proves the script runs. It has to be run against
 * data that exercises the thing being checked — trades with real leaf hashes,
 * batched into commits with a real accumulator chain — or the verification step
 * has nothing to disagree with.
 *
 *   DATABASE_URL=file:/tmp/drill.db npx tsx scripts/seed-drill-data.mts
 */
import bs58 from 'bs58';
import { EMPTY_ACCUMULATOR, extendChain, merkleRoot, toHex } from '@probatio/commit';
import { leavesFor, loadTrades } from '@probatio/keeper';
import { hashLeaf } from '@probatio/commit';
import { PUMPFUN_CURVE_FEES } from '@probatio/pools';
import {
  createRankedSeason,
  ensureAccount,
  markConfirmed,
  migrate,
  openDatabase,
  recordIntent,
  recordTrade,
  upsertUser,
} from '@probatio/db';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';

const url = process.env['DATABASE_URL'] ?? 'file:/tmp/drill.db';
const traderCount = Number(process.env['TRADERS'] ?? '12');
const tradesEach = Number(process.env['TRADES_EACH'] ?? '9');

const db = openDatabase({ url });
await migrate(db);

const START = 1_760_000_000_000;
const rules = rulesetFor(1);
const schedule = scheduleFrom(START, rules.durationMs, rules.entryWindowMs);

const seasonId = await createRankedSeason(
  db,
  {
    ordinal: 1,
    name: 'Season 1',
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

/**
 * Deterministic 32-byte keys, encoded the way the chain encodes them.
 *
 * Generating base58 characters directly gives a string of the right length that
 * decodes to the wrong number of bytes, which the leaf encoder rejects — as it
 * should, since an address that is not 32 bytes is not an address.
 */
function fakeAddress(seed: number): string {
  const bytes = new Uint8Array(32);
  let value = (seed * 2_654_435_761) >>> 0;
  for (let i = 0; i < 32; i += 1) {
    value = (value * 1_103_515_245 + 12_345) >>> 0;
    bytes[i] = (value >>> 16) & 0xff;
  }
  return bs58.encode(bytes);
}

const MINTS = [0, 1, 2, 3].map((i) => fakeAddress(9_000 + i));
let slot = 300_000;

for (let t = 0; t < traderCount; t += 1) {
  const trader = fakeAddress(t);
  await upsertUser(db, trader, START);
  const account = await ensureAccount(db, seasonId, trader, START);

  let held = 0n;
  let basis = 0n;
  let realized = 0n;

  for (let i = 0; i < tradesEach; i += 1) {
    slot += 1;
    const mint = MINTS[(t + i) % MINTS.length]!;
    const buying = held === 0n || i % 3 !== 2;

    const solAmount = BigInt(200_000_000 + ((t * 31 + i * 17) % 40) * 5_000_000);
    const tokenAmount = BigInt(100_000 + ((t * 13 + i * 7) % 50) * 1_000);

    if (buying) {
      held += tokenAmount;
      basis += solAmount;
    } else {
      const sold = held;
      const cost = basis;
      realized += solAmount - cost;
      held = 0n;
      basis = 0n;
      await recordTradeRow(mint, 'sell', solAmount, sold, held, basis, realized, true);
      continue;
    }
    await recordTradeRow(mint, 'buy', solAmount, tokenAmount, held, basis, realized, false);
  }

  async function recordTradeRow(
    mint: string,
    side: 'buy' | 'sell',
    solAmount: bigint,
    tokenAmount: bigint,
    nowHeld: bigint,
    nowBasis: bigint,
    nowRealized: bigint,
    closed: boolean,
  ): Promise<void> {
    const solReserve = BigInt(30_000_000_000 + slot);
    const tokenReserve = BigInt(1_000_000_000_000 - slot * 1_000);

    // The same leaf the trade route builds, so the stored hash and the keeper's
    // rebuild agree. A placeholder here is caught immediately, which is the
    // keeper doing its job.
    const leafBase = {
      seasonOrdinal: 1,
      trader,
      mint,
      side,
      solAmount,
      tokenAmount,
      feeLamports: 2_500_000n,
      solReserve,
      tokenReserve,
      deliverableTokens: tokenReserve,
      feeBps: PUMPFUN_CURVE_FEES.protocolBps + PUMPFUN_CURVE_FEES.creatorBps,
      poolSource: 'pumpfun-curve' as const,
      priceImpactBps: 25,
      partial: false,
      clickedAtSlot: slot - 1,
      filledAtSlot: slot,
      latencyMs: 600,
      engineVersion: 1,
      createdAt: START + slot * 1_000,
    };

    await recordTrade(db, {
      snapshot: {
        mint,
        solReserve: solReserve.toString(),
        tokenReserve: tokenReserve.toString(),
        tokenDecimals: 6,
        feeBps: 125,
        source: 'pumpfun-curve',
        slot,
      },
      trade: {
        accountId: account.id,
        seasonId,
        userPubkey: trader,
        mint,
        side,
        solAmount: solAmount.toString(),
        tokenAmount: tokenAmount.toString(),
        fee: '2500000',
        priceImpactBps: 25,
        partial: false,
        poolSource: 'pumpfun-curve',
        clickedAtSlot: slot - 1,
        filledAtSlot: slot,
        latencyMs: 600,
        engineVersion: 1,
      },
      position: {
        accountId: account.id,
        mint,
        tokenAmount: nowHeld.toString(),
        costBasis: nowBasis.toString(),
        realizedPnl: nowRealized.toString(),
        closed,
      },
      // One fill per account here, so the starting balance is what it sees.
      expected: { solBalance: String(10_000_000_000n), tokenAmount: null },
      newBalance: String(10_000_000_000n - basis),
      leafHashFor: (sequence) => toHex(hashLeaf({ ...leafBase, sequence })),
      now: START + slot * 1_000,
    });
  }
}

// Commit each trader's trades in batches, exactly as the keeper does, so the
// stored roots and accumulators are real rather than placeholders.
const traders = (
  await db.execute({ sql: 'SELECT DISTINCT user_pubkey AS p FROM trades WHERE season_id = ?', args: [seasonId] })
).rows.map((row) => String(row['p']));

let commits = 0;
for (const trader of traders) {
  const ids = (
    await db.execute({
      sql: 'SELECT id FROM trades WHERE season_id = ? AND user_pubkey = ? ORDER BY id',
      args: [seasonId, trader],
    })
  ).rows.map((row) => Number(row['id']));

  let accumulator = EMPTY_ACCUMULATOR;
  for (let i = 0; i < ids.length; i += 4) {
    const chunk = ids.slice(i, i + 4);
    const from = chunk[0]!;
    const to = chunk[chunk.length - 1]!;

    const trades = await loadTrades(db, seasonId, trader, from, to);
    const leaves = leavesFor(trades);
    const root = merkleRoot(leaves.map(hashLeaf));
    const previous = accumulator;
    accumulator = extendChain(previous, root, leaves.length, 1);

    const id = await recordIntent(
      db,
      {
        seasonId,
        userPubkey: trader,
        merkleRoot: toHex(root),
        leafCount: leaves.length,
        fromTradeId: from,
        toTradeId: to,
        engineVersion: 1,
        previousAccumulator: toHex(previous),
        predictedAccumulator: toHex(accumulator),
      },
      START,
    );
    await markConfirmed(db, id, `drill-sig-${commits}`, 400_000 + commits, START);
    commits += 1;
  }
}

const counts = await db.execute('SELECT (SELECT COUNT(*) FROM trades) AS t, (SELECT COUNT(*) FROM commits) AS c');
console.log(`seeded ${counts.rows[0]!['t']} trades and ${counts.rows[0]!['c']} commits for ${traders.length} traders`);
