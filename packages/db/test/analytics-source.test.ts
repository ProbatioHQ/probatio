import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconstruct, computeMetrics, type LoggedTrade } from '@probatio/analytics';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  allTrades,
  ensureAccount,
  ensureFreePlaySeason,
  priceRange,
  recordTrade,
  upsertUser,
  writeCandles,
} from '../src/index';

/**
 * The join between the ledger and the analytics engine.
 *
 * The engine is tested against hand-built logs elsewhere. What this checks is
 * that a trade written through `recordTrade` comes back out in a shape the
 * engine reads correctly — right order, right units, right sign — because a
 * profile built from misread rows would be confidently wrong rather than
 * obviously broken.
 */

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT = 'So11111111111111111111111111111111111111112';

let harness: TestDatabase;
let accountId: number;
let seasonId: number;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, 1_700_000_000_000);
  seasonId = await ensureFreePlaySeason(harness.db, 1_700_000_000_000);
  const account = await ensureAccount(harness.db, seasonId, PUBKEY, 1_700_000_000_000);
  accountId = account.id;
});

afterEach(() => harness.cleanup());

/**
 * What the account and position hold right now.
 *
 * `recordTrade` writes conditionally on this: the balance and holding a fill
 * was quoted against must still be there when it lands, or the fill is void.
 * These fixtures make trades in sequence, so each one reads what the last one
 * left rather than asserting a constant.
 */
async function priorState(
  db: import('@libsql/client').Client,
  id: number,
  mint: string,
): Promise<{ solBalance: string; tokenAmount: string | null }> {
  const account = await db.execute({
    sql: 'SELECT sol_balance FROM accounts WHERE id = ?',
    args: [id],
  });
  const position = await db.execute({
    sql: `SELECT token_amount FROM positions
          WHERE account_id = ? AND mint = ? AND closed_at IS NULL
          ORDER BY opened_at DESC LIMIT 1`,
    args: [id, mint],
  });
  return {
    solBalance: String(account.rows[0]!['sol_balance']),
    tokenAmount: position.rows[0] ? String(position.rows[0]['token_amount']) : null,
  };
}

let slot = 100;

async function record(
  side: 'buy' | 'sell',
  solAmount: string,
  tokenAmount: string,
  at: number,
  position: { tokenAmount: string; costBasis: string; realizedPnl: string; closed: boolean },
): Promise<void> {
  slot += 1;
  const prior = await priorState(harness.db, accountId, MINT);
  await recordTrade(harness.db, {
    snapshot: {
      mint: MINT,
      solReserve: '30000000000',
      tokenReserve: '1000000000000',
      deliverableTokens: '1000000000000',
      tokenDecimals: 6,
      feeBps: 125,
      source: 'pumpfun-curve',
      slot,
    },
    trade: {
      accountId,
      seasonId,
      userPubkey: PUBKEY,
      mint: MINT,
      side,
      solAmount,
      tokenAmount,
      fee: '12500000',
      priceImpactBps: 40,
      partial: false,
      poolSource: 'pumpfun-curve',
      clickedAtSlot: slot - 1,
      filledAtSlot: slot,
      latencyMs: 600,
      engineVersion: 1,
    },
    position: { accountId, mint: MINT, ...position },
    expected: prior,
    newBalance: '10000000000',
    leafHashFor: (sequence) => `hash-${sequence}`,
    now: at,
  });
}

describe('reading a log back for analytics', () => {
  it('returns trades oldest first', async () => {
    await record('buy', '1000000000', '1000000', 1_000, {
      tokenAmount: '1000000',
      costBasis: '1000000000',
      realizedPnl: '0',
      closed: false,
    });
    await record('sell', '1500000000', '1000000', 2_000, {
      tokenAmount: '0',
      costBasis: '0',
      realizedPnl: '500000000',
      closed: true,
    });

    const rows = await allTrades(harness.db, accountId);
    expect(rows.map((row) => row.side)).toEqual(['buy', 'sell']);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
  });

  it('rebuilds the round trip the ledger recorded', async () => {
    await record('buy', '1000000000', '1000000', 1_000, {
      tokenAmount: '1000000',
      costBasis: '1000000000',
      realizedPnl: '0',
      closed: false,
    });
    await record('sell', '1500000000', '1000000', 61_000, {
      tokenAmount: '0',
      costBasis: '0',
      realizedPnl: '500000000',
      closed: true,
    });

    const rows = await allTrades(harness.db, accountId);
    const log: LoggedTrade[] = rows.map((row) => ({
      mint: row.mint,
      side: row.side,
      solAmount: BigInt(row.solAmount),
      tokenAmount: BigInt(row.tokenAmount),
      feeLamports: BigInt(row.fee),
      priceImpactBps: row.priceImpactBps,
      at: row.createdAt,
    }));

    const { closed } = reconstruct(log);
    expect(closed).toHaveLength(1);

    // The engine's answer has to be the ledger's answer. This is the same
    // number the merkle leaf commits to.
    const stored = await harness.db.execute({
      sql: 'SELECT realized_pnl FROM positions WHERE account_id = ? AND mint = ?',
      args: [accountId, MINT],
    });
    expect(closed[0]!.realized).toBe(BigInt(String(stored.rows[0]!['realized_pnl'])));

    const metrics = computeMetrics(closed);
    expect(metrics.wins).toBe(1);
    expect(metrics.winRateBps).toBe(10_000);
    expect(metrics.holdMs.average).toBe(60_000);
  });
});

describe('the price range a position lived through', () => {
  beforeEach(async () => {
    await writeCandles(harness.db, MINT, '1m', [
      { openTime: 60, open: 100n, high: 150n, low: 90n, close: 120n, volumeLamports: 1n, trades: 1 },
      { openTime: 120, open: 120n, high: 900n, low: 80n, close: 400n, volumeLamports: 1n, trades: 1 },
      { openTime: 180, open: 400n, high: 410n, low: 390n, close: 400n, volumeLamports: 1n, trades: 1 },
    ]);
  });

  it('takes the high and low across the whole span', async () => {
    const range = await priceRange(harness.db, MINT, '1m', 60, 180);
    expect(range).toEqual({ high: 900n, low: 80n });
  });

  it('only looks inside the span it was asked about', async () => {
    const range = await priceRange(harness.db, MINT, '1m', 60, 60);
    expect(range).toEqual({ high: 150n, low: 90n });
  });

  it('compares prices as numbers, not as text', async () => {
    // '900' sorts below '90' lexicographically. A text MAX would report the
    // high as 410 and quietly understate every excursion on the token.
    const range = await priceRange(harness.db, MINT, '1m', 60, 180);
    expect(range!.high).toBe(900n);
  });

  it('has no range for a span with no candles', async () => {
    expect(await priceRange(harness.db, MINT, '1m', 10_000, 20_000)).toBeNull();
  });

  it('has no range for a token it has never seen', async () => {
    expect(await priceRange(harness.db, 'unknown', '1m', 0, 999_999)).toBeNull();
  });
});
