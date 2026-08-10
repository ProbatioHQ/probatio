import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  ConcurrentTradeError,
  ensureAccount,
  ensureFreePlaySeason,
  openPosition,
  recordTrade,
  upsertUser,
} from '../src/index';

/**
 * Two trades landing at once.
 *
 * The trade route reads a balance, waits out the season's latency — six hundred
 * milliseconds of it — and only then writes the result. That gap is wide enough
 * to drive two requests through, and the write used to set an absolute balance
 * computed before the wait. Both would pass the affordability check, both would
 * write the same "after" figure, and the trader would have bought twice with
 * one balance.
 *
 * That is not a rounding error. Practice SOL is what the leaderboard ranks on,
 * and a season pays real money, so minting it is the cheapest way to win.
 *
 * The write is now conditional on the balance still being what was quoted
 * against. These tests hold that line.
 */

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT = 'So11111111111111111111111111111111111111112';
const START = 10_000_000_000n;
const NOW = 1_700_000_000_000;

let harness: TestDatabase;
let accountId: number;
let seasonId: number;
let slot = 500;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, NOW);
  seasonId = await ensureFreePlaySeason(harness.db, NOW);
  const account = await ensureAccount(harness.db, seasonId, PUBKEY, NOW);
  accountId = account.id;
});

afterEach(() => harness.cleanup());

async function balanceNow(): Promise<bigint> {
  const row = await harness.db.execute({
    sql: 'SELECT sol_balance FROM accounts WHERE id = ?',
    args: [accountId],
  });
  return BigInt(String(row.rows[0]!['sol_balance']));
}

/** A buy that spends `spend` lamports, quoted against `expectedBalance`. */
function buy(spend: bigint, expectedBalance: bigint, heldBefore: bigint, heldAfter: bigint) {
  slot += 1;
  return recordTrade(harness.db, {
    snapshot: {
      mint: MINT,
      solReserve: '30000000000',
      tokenReserve: '1000000000000',
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
      side: 'buy',
      solAmount: spend.toString(),
      tokenAmount: (heldAfter - heldBefore).toString(),
      fee: '0',
      priceImpactBps: 10,
      partial: false,
      poolSource: 'pumpfun-curve',
      clickedAtSlot: slot - 1,
      filledAtSlot: slot,
      latencyMs: 600,
      engineVersion: 1,
    },
    position: {
      accountId,
      mint: MINT,
      tokenAmount: heldAfter.toString(),
      costBasis: spend.toString(),
      realizedPnl: '0',
      closed: false,
    },
    // What the engine quoted against. The write only lands if it still holds.
    expected: { solBalance: expectedBalance.toString(), tokenAmount: heldBefore.toString() },
    newBalance: (expectedBalance - spend).toString(),
    leafHashFor: (sequence) => `hash-${sequence}`,
    now: NOW,
  });
}

describe('two trades against one balance', () => {
  it('lets the first through', async () => {
    await buy(START, START, 0n, 1_000n);
    expect(await balanceNow()).toBe(0n);
  });

  it('refuses the second rather than spending the balance twice', async () => {
    await buy(START, START, 0n, 1_000n);

    // The second request was quoted against the same starting balance, because
    // it read it before the first one had written anything.
    await expect(buy(START, START, 0n, 1_000n)).rejects.toThrow(ConcurrentTradeError);
  });

  it('leaves the balance untouched when it refuses', async () => {
    await buy(4_000_000_000n, START, 0n, 1_000n);
    const after = await balanceNow();

    await expect(buy(START, START, 0n, 1_000n)).rejects.toThrow(ConcurrentTradeError);

    expect(await balanceNow()).toBe(after);
  });

  it('writes no trade row for the refused one', async () => {
    await buy(START, START, 0n, 1_000n);
    await expect(buy(START, START, 0n, 1_000n)).rejects.toThrow(ConcurrentTradeError);

    const rows = await harness.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM trades WHERE account_id = ?',
      args: [accountId],
    });
    // A rolled-back trade must leave nothing behind — a phantom row would be
    // committed to the chain by the keeper and could never be taken back.
    expect(Number(rows.rows[0]!['n'])).toBe(1);
  });

  it('refuses when the position moved under it, even if the balance did not', async () => {
    await buy(1_000_000_000n, START, 0n, 5_000n);

    // Correct balance, stale holding: a concurrent sell emptied the position
    // between the quote and the write.
    await expect(
      buy(1_000_000_000n, START - 1_000_000_000n, 0n, 5_000n),
    ).rejects.toThrow(ConcurrentTradeError);
  });

  it('accepts the retry once it is quoted against what is really there', async () => {
    await buy(4_000_000_000n, START, 0n, 1_000n);

    const position = await openPosition(harness.db, accountId, MINT);

    await buy(1_000_000_000n, await balanceNow(), BigInt(position!.tokenAmount), 2_000n);

    expect(await balanceNow()).toBe(START - 5_000_000_000n);
  });

  it('holds when several land together', async () => {
    // Ten requests, every one quoted against the untouched starting balance.
    // Exactly one may win.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => buy(START, START, 0n, 1_000n)),
    );

    const won = results.filter((r) => r.status === 'fulfilled').length;
    expect(won).toBe(1);

    expect(await balanceNow()).toBe(0n);
  });
});
