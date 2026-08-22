import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { recordObservedSwaps, tokenTimeline, type ObservedSwap } from '../src/index';

/**
 * One token's swaps, in the order a replay reads them.
 *
 * The mirror of the copy backtest's reader. That one asks what a wallet did;
 * this asks what happened to a token, because a rule is walked forward through
 * the pool that real orders left behind.
 */

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = 'So11111111111111111111111111111111111111112';
const NOW = 1_700_000_000_000;

let harness: TestDatabase;
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(() => harness.cleanup());

function swap(over: Partial<ObservedSwap> & { signature: string }): ObservedSwap {
  return {
    trader: 'Trader1111111111111111111111111111111111111',
    mint: MINT,
    isBuy: true,
    solAmount: '1000000000',
    tokenAmount: '1000000',
    slot: 100,
    blockTime: 1_700_000_000,
    solAfter: '300000000000',
    tokenAfter: '1000000000000000',
    ...over,
  };
}

describe('reading a token forward', () => {
  it('returns only the token asked for', async () => {
    await recordObservedSwaps(
      harness.db,
      [swap({ signature: 'a' }), swap({ signature: 'b', mint: OTHER })],
      NOW,
    );

    const { swaps } = await tokenTimeline(harness.db, MINT);
    expect(swaps.map((one) => one.mint)).toEqual([MINT]);
  });

  /*
   * Oldest first, because a replay reads forward, and slot breaks the tie since
   * two swaps in one block share a time and only their slot ordering is real.
   */
  it('is ordered by time, then by slot', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        swap({ signature: 'late', blockTime: 1_700_000_120, slot: 300 }),
        swap({ signature: 'same-block-second', blockTime: 1_700_000_060, slot: 201 }),
        swap({ signature: 'same-block-first', blockTime: 1_700_000_060, slot: 200 }),
        swap({ signature: 'early', blockTime: 1_700_000_000, slot: 100 }),
      ],
      NOW,
    );

    const { swaps } = await tokenTimeline(harness.db, MINT);
    expect(swaps.map((one) => one.blockTime)).toEqual([
      1_700_000_000, 1_700_000_060, 1_700_000_060, 1_700_000_120,
    ]);
  });

  /*
   * A point without reserves cannot price anything, and a replay that guessed
   * at one would be worth less than no replay at all.
   */
  it('leaves out anything it could not price', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        swap({ signature: 'priced' }),
        swap({ signature: 'no-reserves', solAfter: null, tokenAfter: null }),
        swap({ signature: 'empty-pool', solAfter: '0', tokenAfter: '0' }),
        swap({ signature: 'no-time', blockTime: null }),
      ],
      NOW,
    );

    const { swaps } = await tokenTimeline(harness.db, MINT);
    expect(swaps).toHaveLength(1);
  });

  it('stops at the limit rather than reading a whole token', async () => {
    await recordObservedSwaps(
      harness.db,
      Array.from({ length: 20 }, (_, index) =>
        swap({ signature: `s${index}`, blockTime: 1_700_000_000 + index, slot: 100 + index }),
      ),
      NOW,
    );

    const { swaps, truncated } = await tokenTimeline(harness.db, MINT, 5);
    expect(swaps).toHaveLength(5);
    // The oldest five, since a replay starts at the beginning.
    expect(swaps[0]?.blockTime).toBe(1_700_000_000);

    /*
     * And it says the read stopped before the token did. A window that ends
     * because there are more swaps than a replay will read is not a window that
     * ends because the token went quiet, and a rule reported as never having
     * triggered inside the first has no verdict rather than a failing one.
     */
    expect(truncated).toBe(true);
  });

  it('says nothing was cut when the whole token fits', async () => {
    await recordObservedSwaps(
      harness.db,
      Array.from({ length: 5 }, (_, index) =>
        swap({ signature: `s${index}`, blockTime: 1_700_000_000 + index, slot: 100 + index }),
      ),
      NOW,
    );

    const { swaps, truncated } = await tokenTimeline(harness.db, MINT, 5);
    expect(swaps).toHaveLength(5);
    expect(truncated).toBe(false);
  });

  it('says nothing at all for a token nobody has walked', async () => {
    expect(await tokenTimeline(harness.db, MINT)).toEqual({ swaps: [], truncated: false });
  });
});
