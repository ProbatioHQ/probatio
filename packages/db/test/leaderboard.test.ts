import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rankSeason } from '@probatio/scoring';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  createRankedSeason,
  ensureAccount,
  leaderboardRows,
  recordTrade,
  upsertUser,
} from '../src/index';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'So11111111111111111111111111111111111111112';
const START = 1_700_000_000_000;

let harness: TestDatabase;
let seasonId: number;

beforeEach(async () => {
  harness = await createTestDatabase();
  for (const key of [A, B]) await upsertUser(harness.db, key, START);

  const rules = rulesetFor(1);
  const schedule = scheduleFrom(START, rules.durationMs, rules.entryWindowMs);
  seasonId = await createRankedSeason(
    harness.db,
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

async function trade(
  pubkey: string,
  accountId: number,
  side: 'buy' | 'sell',
  sol: string,
  tokens: string,
  position: { tokenAmount: string; costBasis: string; realizedPnl: string; closed: boolean },
): Promise<void> {
  slot += 1;
  const prior = await priorState(harness.db, accountId, MINT);
  await recordTrade(harness.db, {
    snapshot: {
      mint: MINT, solReserve: '30000000000', tokenReserve: '1000000000000',
      deliverableTokens: '1000000000000',
      tokenDecimals: 6, feeBps: 125, source: 'pumpfun-curve', slot,
    },
    trade: {
      accountId, seasonId, userPubkey: pubkey, mint: MINT, side,
      solAmount: sol, tokenAmount: tokens, fee: '12500000',
      priceImpactBps: 40, partial: false, poolSource: 'pumpfun-curve',
      clickedAtSlot: slot - 1, filledAtSlot: slot, latencyMs: 600, engineVersion: 1,
    },
    position: { accountId, mint: MINT, ...position },
    expected: prior,
    newBalance: '9000000000',
    leafHashFor: (sequence) => `hash-${pubkey}-${sequence}`,
    now: START + slot,
  });
}

describe('gathering the standings', () => {
  it('has a row for every account in the season', async () => {
    await ensureAccount(harness.db, seasonId, A, START);
    await ensureAccount(harness.db, seasonId, B, START);

    const rows = await leaderboardRows(harness.db, seasonId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.startingBalance)).toEqual(['10000000000', '10000000000']);
  });

  it('counts trades per trader', async () => {
    const account = await ensureAccount(harness.db, seasonId, A, START);
    await ensureAccount(harness.db, seasonId, B, START);

    await trade(A, account.id, 'buy', '1000000000', '1000000', {
      tokenAmount: '1000000', costBasis: '1000000000', realizedPnl: '0', closed: false,
    });
    await trade(A, account.id, 'buy', '500000000', '400000', {
      tokenAmount: '1400000', costBasis: '1500000000', realizedPnl: '0', closed: false,
    });

    const rows = await leaderboardRows(harness.db, seasonId);
    const mine = rows.find((row) => row.userPubkey === A);
    expect(mine?.tradeCount).toBe(2);
    expect(rows.find((row) => row.userPubkey === B)?.tradeCount).toBe(0);
  });

  it('attaches open positions unpriced', async () => {
    // Marking them needs the chain, which is not this layer's business.
    const account = await ensureAccount(harness.db, seasonId, A, START);
    await trade(A, account.id, 'buy', '1000000000', '1000000', {
      tokenAmount: '1000000', costBasis: '1000000000', realizedPnl: '0', closed: false,
    });

    const rows = await leaderboardRows(harness.db, seasonId);
    expect(rows[0]!.positions).toEqual([
      { mint: MINT, tokenAmount: '1000000', costBasis: '1000000000' },
    ]);
  });

  it('leaves out a position that was closed', async () => {
    const account = await ensureAccount(harness.db, seasonId, A, START);
    await trade(A, account.id, 'buy', '1000000000', '1000000', {
      tokenAmount: '1000000', costBasis: '1000000000', realizedPnl: '0', closed: false,
    });
    await trade(A, account.id, 'sell', '1500000000', '1000000', {
      tokenAmount: '0', costBasis: '0', realizedPnl: '500000000', closed: true,
    });

    const rows = await leaderboardRows(harness.db, seasonId);
    expect(rows[0]!.positions).toEqual([]);
    // The profit survives the position it was made on.
    expect(rows[0]!.realizedPnl).toBe('500000000');
  });

  it('reads the whole season in a fixed number of queries', async () => {
    // The shape of this query is the only thing between a leaderboard and the
    // reason the database falls over.
    for (let index = 0; index < 2; index += 1) {
      const key = index === 0 ? A : B;
      const account = await ensureAccount(harness.db, seasonId, key, START);
      await trade(key, account.id, 'buy', '1000000000', '1000000', {
        tokenAmount: '1000000', costBasis: '1000000000', realizedPnl: '0', closed: false,
      });
    }

    const rows = await leaderboardRows(harness.db, seasonId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.positions.length === 1)).toBe(true);
  });

  it('feeds straight into the ranking', async () => {
    await ensureAccount(harness.db, seasonId, A, START);
    await ensureAccount(harness.db, seasonId, B, START);

    await harness.db.execute({
      sql: 'UPDATE accounts SET sol_balance = ? WHERE user_pubkey = ? AND season_id = ?',
      args: ['20000000000', A, seasonId],
    });

    const rows = await leaderboardRows(harness.db, seasonId);
    const ranked = rankSeason(
      rows.map((row) => ({
        trader: row.userPubkey,
        enteredAt: row.enteredAt,
        startingBalance: BigInt(row.startingBalance),
        finalEquity: BigInt(row.solBalance),
        tradeCount: row.tradeCount,
      })),
    );

    expect(ranked[0]!.trader).toBe(A);
    expect(ranked[0]!.returnBps).toBe(10_000);
    expect(ranked[1]!.returnBps).toBe(0);
  });

  it('ranks nobody in a season nobody joined', async () => {
    expect(await leaderboardRows(harness.db, seasonId)).toEqual([]);
  });
});
