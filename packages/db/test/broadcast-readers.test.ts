import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  createRankedSeason,
  ensureAccount,
  recentDrift,
  recentTrades,
  recordDrift,
  recordTrade,
  upsertUser,
} from '../src/index';

/**
 * The two readers a status board needs and nothing else had.
 *
 * Every other reader in here is scoped: this account's trades, this token's
 * drift. Both are right for a page somebody opened about themselves, and both
 * are useless to something asking how the whole system is doing, which had no
 * way to ask without naming a trader or a mint it did not know yet.
 */

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'So11111111111111111111111111111111111111112';
const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const START = 1_700_000_000_000;

let harness: TestDatabase;
let seasonId: number;
const accounts = new Map<string, number>();
let slot = 100;

beforeEach(async () => {
  harness = await createTestDatabase();
  accounts.clear();
  slot = 100;

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
  for (const key of [A, B]) {
    accounts.set(key, (await ensureAccount(harness.db, seasonId, key, START)).id);
  }
});

afterEach(() => harness.cleanup());

/** One buy. Nothing about it matters here except whose it was and when. */
async function fill(pubkey: string, mint = MINT): Promise<void> {
  slot += 1;
  const accountId = accounts.get(pubkey)!;
  const account = await harness.db.execute({
    sql: 'SELECT sol_balance FROM accounts WHERE id = ?',
    args: [accountId],
  });
  const position = await harness.db.execute({
    sql: 'SELECT token_amount FROM positions WHERE account_id = ? AND mint = ? AND closed_at IS NULL',
    args: [accountId, mint],
  });
  const held = position.rows[0] ? BigInt(String(position.rows[0]['token_amount'])) : 0n;

  await recordTrade(harness.db, {
    snapshot: {
      mint, solReserve: '30000000000', tokenReserve: '1000000000000',
      deliverableTokens: '1000000000000', tokenDecimals: 6, feeBps: 125,
      source: 'pumpfun-curve', slot,
    },
    trade: {
      accountId, seasonId, userPubkey: pubkey, mint, side: 'buy',
      solAmount: '1000000000', tokenAmount: '1000000', fee: '12500000',
      priceImpactBps: 40, partial: false, poolSource: 'pumpfun-curve',
      clickedAtSlot: slot - 1, filledAtSlot: slot, latencyMs: 600, engineVersion: 1,
    },
    position: {
      accountId, mint,
      tokenAmount: (held + 1_000_000n).toString(),
      costBasis: '1000000000', realizedPnl: '0', closed: false,
    },
    expected: {
      solBalance: String(account.rows[0]!['sol_balance']),
      tokenAmount: position.rows[0] ? String(position.rows[0]['token_amount']) : null,
    },
    newBalance: '9000000000',
    leafHashFor: (sequence) => `hash-${pubkey}-${slot}-${sequence}`,
    now: START + slot,
  });
}

describe('the tape', () => {
  it('crosses accounts, which every other reader refuses to do', async () => {
    await fill(A);
    await fill(B);
    await fill(A);

    const tape = await recentTrades(harness.db, 10);
    expect(tape).toHaveLength(3);
    expect(new Set(tape.map((t) => t.pubkey))).toEqual(new Set([A, B]));
  });

  it('is newest first, so a board reads down the page', async () => {
    await fill(A);
    await fill(B);

    const tape = await recentTrades(harness.db, 10);
    expect(tape[0]!.pubkey).toBe(B);
    expect(tape[1]!.pubkey).toBe(A);
  });

  /*
   * The seal travels with the row. Without it the tape is a list of claims, and
   * a claim on a broadcast is exactly what this whole project argues against.
   */
  it('carries the hash the fill was sealed with', async () => {
    await fill(A);
    const [row] = await recentTrades(harness.db, 1);
    expect(row!.leafHash).toMatch(/^hash-/);
    expect(row!.poolSource).toBe('pumpfun-curve');
  });

  it('takes only what it was asked for', async () => {
    for (let i = 0; i < 5; i += 1) await fill(A);
    expect(await recentTrades(harness.db, 2)).toHaveLength(2);
  });
});

describe('drift across every token', () => {
  /*
   * `observedAt` is the batch's clock, not the observation's: one pass stamps
   * everything it measured with the same instant, so a cycle cannot be spread
   * across a boundary by the time its writes land.
   */
  const observe = (mint: string, at: number, absBps: number) =>
    recordDrift(
      harness.db,
      [{
        mint,
        engineVersion: 1,
        samples: 10,
        medianSignedBps: absBps,
        medianAbsBps: absBps,
        generousSamples: 0,
        severity: 'ok' as const,
      }],
      at,
    );

  it('answers without being told which token to look at', async () => {
    await observe(MINT, START, 12);
    await observe(OTHER, START + 1, 40);

    const rows = await recentDrift(harness.db, 10);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.mint))).toEqual(new Set([MINT, OTHER]));
  });

  it('is newest first across tokens, not grouped by one', async () => {
    await observe(MINT, START, 12);
    await observe(OTHER, START + 100, 40);
    await observe(MINT, START + 200, 8);

    const rows = await recentDrift(harness.db, 10);
    expect(rows.map((r) => r.observedAt)).toEqual([START + 200, START + 100, START]);
  });

  it('has nothing to say before the watchdog has run', async () => {
    expect(await recentDrift(harness.db, 10)).toEqual([]);
  });
});
