import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { ensureAccount, ensureFreePlaySeason, upsertUser } from '../src/index';

/**
 * Concurrent writes against a local database.
 *
 * Found by load testing rather than by reading: 500 concurrent trades produced
 * 499 `SQLITE_BUSY` failures and one write. Writes are serialized now, and this
 * is the regression test — it fails loudly if the queue is ever removed on the
 * grounds that it looks unnecessary.
 */

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, Date.now());
});

afterEach(() => harness.cleanup());

describe('many writers at once', () => {
  it('does not lose transactions to lock contention', async () => {
    await harness.db.execute('CREATE TABLE burst (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');

    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, i) => {
        const tx = await harness.db.transaction('write');
        try {
          await tx.execute({ sql: 'INSERT INTO burst (v) VALUES (?)', args: [String(i)] });
          await tx.commit();
          return 'ok';
        } catch (error) {
          await tx.rollback().catch(() => undefined);
          return error instanceof Error ? error.message : String(error);
        }
      }),
    );

    expect(results.filter((r) => r === 'ok')).toHaveLength(60);
    const count = await harness.db.execute('SELECT COUNT(*) AS n FROM burst');
    expect(Number(count.rows[0]!['n'])).toBe(60);
  });

  it('releases the queue when a transaction rolls back', async () => {
    // A failed write that kept its turn would stall every write after it.
    await harness.db.execute('CREATE TABLE strict (id INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)');

    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const tx = await harness.db.transaction('write');
        try {
          // Half of these collide on the unique index and must roll back.
          await tx.execute({ sql: 'INSERT INTO strict (v) VALUES (?)', args: [String(i % 10)] });
          await tx.commit();
          return true;
        } catch {
          await tx.rollback().catch(() => undefined);
          return false;
        }
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(10);
    const count = await harness.db.execute('SELECT COUNT(*) AS n FROM strict');
    expect(Number(count.rows[0]!['n'])).toBe(10);
  });

  it('keeps concurrent account creation to one row', async () => {
    const seasonId = await ensureFreePlaySeason(harness.db, Date.now());
    const accounts = await Promise.all(
      Array.from({ length: 15 }, () => ensureAccount(harness.db, seasonId, PUBKEY, Date.now())),
    );

    const ids = new Set(accounts.map((account) => account.id));
    expect(ids.size).toBe(1);
  });
});
