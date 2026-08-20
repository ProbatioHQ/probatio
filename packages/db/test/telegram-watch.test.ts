import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  MAX_WATCHES_PER_CHAT,
  advanceWatch,
  createRankedSeason,
  dropChat,
  ensureAccount,
  pendingFills,
  recordTrade,
  unwatchTrader,
  upsertUser,
  watchTrader,
  watchesFor,
} from '../src/index';

/**
 * Fills pushed into a chat as they land.
 *
 * All of this is about the cursor. Trade ids are an autoincrementing integer on
 * an append-only table, so what a chat has been told is a single number and
 * what is owed is a range: no timestamps, no windows, nothing that goes wrong
 * when two passes overlap or one is missed.
 */

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'So11111111111111111111111111111111111111112';
const START = 1_700_000_000_000;
const ROOM = -100;

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

/** One buy, and nothing about it matters here except that it exists. */
async function fill(pubkey: string): Promise<void> {
  slot += 1;
  const accountId = accounts.get(pubkey)!;
  const account = await harness.db.execute({
    sql: 'SELECT sol_balance FROM accounts WHERE id = ?',
    args: [accountId],
  });
  const position = await harness.db.execute({
    sql: `SELECT token_amount FROM positions WHERE account_id = ? AND mint = ? AND closed_at IS NULL`,
    args: [accountId, MINT],
  });
  const held = position.rows[0] ? BigInt(String(position.rows[0]['token_amount'])) : 0n;

  await recordTrade(harness.db, {
    snapshot: {
      mint: MINT, solReserve: '30000000000', tokenReserve: '1000000000000',
      deliverableTokens: '1000000000000', tokenDecimals: 6, feeBps: 125,
      source: 'pumpfun-curve', slot,
    },
    trade: {
      accountId, seasonId, userPubkey: pubkey, mint: MINT, side: 'buy',
      solAmount: '1000000000', tokenAmount: '1000000', fee: '12500000',
      priceImpactBps: 40, partial: false, poolSource: 'pumpfun-curve',
      clickedAtSlot: slot - 1, filledAtSlot: slot, latencyMs: 600, engineVersion: 1,
    },
    position: {
      accountId, mint: MINT,
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

describe('subscribing', () => {
  /*
   * The thing that would otherwise be unusable. Subscribing to somebody with
   * two thousand fills must not replay two thousand fills into the room.
   */
  it('starts at the trader’s newest fill, not at the beginning', async () => {
    await fill(A);
    await fill(A);
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });

    expect(await pendingFills(harness.db)).toEqual([]);

    await fill(A);
    const owed = await pendingFills(harness.db);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({ chatId: ROOM, trader: A, side: 'buy', solAmount: '1000000000' });
  });

  it('is one subscription however many times it is asked for', async () => {
    expect(await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START })).toBe('added');
    expect(await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 2, trader: A, now: START })).toBe('already');
    expect(await watchesFor(harness.db, ROOM)).toHaveLength(1);
  });

  /*
   * A ceiling rather than a policy. Without it one member of a group can
   * subscribe the room to every wallet on the platform, and the room's only
   * recourse is removing the bot.
   */
  it('will not let one member fill a room up', async () => {
    for (let index = 0; index < MAX_WATCHES_PER_CHAT; index += 1) {
      const trader = `${index}`.padStart(32, '1');
      expect(await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader, now: START })).toBe('added');
    }
    expect(await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: B, now: START })).toBe('too_many');
  });

  it('watches the same trader in two rooms independently', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    await watchTrader(harness.db, { chatId: -200, telegramUserId: 2, trader: A, now: START });
    await fill(A);

    expect((await pendingFills(harness.db)).map((owed) => owed.chatId).sort((left, right) => left - right)).toEqual([-200, -100]);
  });

  it('stops when told to, and says whether it was watching', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    expect(await unwatchTrader(harness.db, ROOM, A)).toBe(true);
    expect(await unwatchTrader(harness.db, ROOM, A)).toBe(false);
    await fill(A);
    expect(await pendingFills(harness.db)).toEqual([]);
  });
});

describe('the cursor', () => {
  it('owes everything after where it was left', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    await fill(A);
    await fill(A);
    await fill(A);

    const owed = await pendingFills(harness.db);
    expect(owed).toHaveLength(3);

    const [watch] = await watchesFor(harness.db, ROOM);
    await advanceWatch(harness.db, watch!.id, owed[1]!.tradeId);
    expect(await pendingFills(harness.db)).toHaveLength(1);
  });

  /*
   * Two passes overlapping, a slow one and the next one starting, would let the
   * older pass rewind the cursor and replay everything the newer one had
   * already sent.
   */
  it('never moves backwards', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    await fill(A);
    await fill(A);

    const owed = await pendingFills(harness.db);
    const [watch] = await watchesFor(harness.db, ROOM);
    await advanceWatch(harness.db, watch!.id, owed[1]!.tradeId);
    await advanceWatch(harness.db, watch!.id, owed[0]!.tradeId);

    expect(await pendingFills(harness.db)).toEqual([]);
  });

  it('delivers only the trader that was asked for', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    await fill(B);
    await fill(A);

    const owed = await pendingFills(harness.db);
    expect(owed.map((one) => one.trader)).toEqual([A]);
  });

  /*
   * The limit bounds a pass, not a chat. Whatever does not fit is still owed,
   * its cursor has not moved, and the next pass picks it up.
   */
  it('leaves what did not fit in a pass still owed', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    for (let index = 0; index < 5; index += 1) await fill(A);

    expect(await pendingFills(harness.db, 2)).toHaveLength(2);
    expect(await pendingFills(harness.db)).toHaveLength(5);
  });
});

describe('a chat that is gone', () => {
  it('takes its watches with it', async () => {
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: A, now: START });
    await watchTrader(harness.db, { chatId: ROOM, telegramUserId: 1, trader: B, now: START });
    await watchTrader(harness.db, { chatId: -200, telegramUserId: 2, trader: A, now: START });

    expect(await dropChat(harness.db, ROOM)).toBe(2);
    expect(await watchesFor(harness.db, ROOM)).toEqual([]);
    expect(await watchesFor(harness.db, -200)).toHaveLength(1);
  });
});
