import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { lastPrices, writeCandles } from '../src/index';

/**
 * Marking an open position against a price already on disk.
 *
 * The leaderboard used to read the chain for every held token, which is the
 * accurate way and does not finish: twenty-nine held tokens is twenty-nine pool
 * resolutions of several round trips each against a four second budget, sharing
 * an endpoint with every other job. All twenty-nine came back unpriced, so every
 * position was marked at what it cost and every row on the board showed exactly
 * the balance it started with, whatever it had actually traded.
 */

const MINT = 'Mint111111111111111111111111111111111111111';
const OTHER = 'Mint222222222222222222222222222222222222222';
const NOW = 1_800_000_000;

let harness: TestDatabase;
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(() => harness.cleanup());

function candle(at: number, close: bigint) {
  return {
    openTime: at,
    open: close,
    high: close,
    low: close,
    close,
    volumeLamports: 0n,
    trades: 1,
  };
}

describe('the last price on disk', () => {
  it('takes the most recent close for each mint', async () => {
    await writeCandles(harness.db, MINT, '1m', [candle(NOW - 600, 900n), candle(NOW - 60, 1200n)]);
    await writeCandles(harness.db, OTHER, '1m', [candle(NOW - 120, 7n)]);

    const prices = await lastPrices(harness.db, [MINT, OTHER]);
    expect(prices.get(MINT)).toBe('1200');
    expect(prices.get(OTHER)).toBe('7');
  });

  /*
   * A position carried at a price from another day is worse than one carried at
   * cost, because it looks current. Stale falls through to the chain read.
   */
  it('refuses a price older than the caller allows', async () => {
    await writeCandles(harness.db, MINT, '1m', [candle(NOW - 86_400, 900n)]);

    expect((await lastPrices(harness.db, [MINT], NOW - 1_200)).size).toBe(0);
    expect((await lastPrices(harness.db, [MINT], NOW - 90_000)).get(MINT)).toBe('900');
  });

  it('says nothing about a mint it has never seen', async () => {
    expect((await lastPrices(harness.db, [MINT])).size).toBe(0);
    expect((await lastPrices(harness.db, [])).size).toBe(0);
  });
});
