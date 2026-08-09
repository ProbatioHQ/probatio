import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cohorts, dayNumber, summarize } from '@probatio/retention';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { activeOn, allActivity, recordActivity, upsertUser } from '../src/index';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DAY = dayNumber(Date.UTC(2026, 0, 1));

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  for (const key of [A, B]) await upsertUser(harness.db, key, Date.now());
});

afterEach(() => harness.cleanup());

describe('recording a day', () => {
  it('records a wallet once however many requests it makes', async () => {
    for (let i = 0; i < 20; i += 1) await recordActivity(harness.db, A, DAY, false);
    expect(await activeOn(harness.db, DAY)).toBe(1);
  });

  it('records separate days separately', async () => {
    await recordActivity(harness.db, A, DAY, false);
    await recordActivity(harness.db, A, DAY + 1, false);
    expect(await allActivity(harness.db)).toHaveLength(2);
  });

  it('remembers that a wallet traded', async () => {
    await recordActivity(harness.db, A, DAY, true);
    expect((await allActivity(harness.db))[0]!.traded).toBe(true);
  });

  it('does not let a later visit erase a trade', async () => {
    // Trading in the morning and browsing in the afternoon is a day they
    // traded.
    await recordActivity(harness.db, A, DAY, true);
    await recordActivity(harness.db, A, DAY, false);
    expect((await allActivity(harness.db))[0]!.traded).toBe(true);
  });

  it('upgrades a browsing day when a trade happens', async () => {
    await recordActivity(harness.db, A, DAY, false);
    await recordActivity(harness.db, A, DAY, true);
    expect((await allActivity(harness.db))[0]!.traded).toBe(true);
  });

  it('keeps wallets apart', async () => {
    await recordActivity(harness.db, A, DAY, false);
    await recordActivity(harness.db, B, DAY, false);
    expect(await activeOn(harness.db, DAY)).toBe(2);
  });

  it('reads only from a day onward when asked', async () => {
    await recordActivity(harness.db, A, DAY, false);
    await recordActivity(harness.db, A, DAY + 5, false);
    expect(await allActivity(harness.db, DAY + 1)).toHaveLength(1);
  });
});

describe('feeding the cohort report', () => {
  it('answers whether people came back', async () => {
    // Two wallets on day one; one returns the next day and trades.
    await recordActivity(harness.db, A, DAY, false);
    await recordActivity(harness.db, B, DAY, false);
    await recordActivity(harness.db, A, DAY + 1, true);

    const rows = await allActivity(harness.db);
    const list = cohorts(
      rows.map((row) => ({ pubkey: row.userPubkey, day: row.day, traded: row.traded })),
      { today: DAY + 8 },
    );
    const summary = summarize(list, DAY + 8);

    expect(summary.wallets).toBe(2);
    expect(summary.d1Bps).toBe(5_000);
    expect(summary.activated).toBe(1);
  });

  it('stores nothing beyond a wallet and a day', async () => {
    // The privacy claim, asserted rather than promised in a comment. If a
    // column is ever added here, this fails and somebody has to think about it.
    await recordActivity(harness.db, A, DAY, true);
    const columns = await harness.db.execute('PRAGMA table_info(activity)');
    expect(columns.rows.map((row) => String(row['name'])).sort()).toEqual([
      'day',
      'traded',
      'user_pubkey',
    ]);
  });
});
