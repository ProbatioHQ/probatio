import { describe, expect, it } from 'vitest';
import { computeDrawdown } from '../src/drawdown';
import type { RoundTrip } from '../src/roundtrips';

function trip(realized: bigint, closedAt: number): RoundTrip {
  return {
    mint: 'M',
    openedAt: closedAt - 1_000,
    closedAt,
    heldMs: 1_000,
    invested: 1_000n,
    proceeds: 1_000n + realized,
    realized,
    feesPaid: 0n,
    buys: 1,
    sells: 1,
    peakTokens: 1n,
    tokensBought: 1n,
    tokensSold: 1n,
    trades: [],
  };
}

const START = 10_000_000_000n;

describe('the equity curve', () => {
  it('is flat and undrawn when everything wins', () => {
    const result = computeDrawdown([trip(100n, 1), trip(200n, 2)], START);

    expect(result.maxDrawdown).toBe(0n);
    expect(result.maxDrawdownBps).toBe(0);
    expect(result.troughAt).toBeNull();
    expect(result.curve.at(-1)!.equity).toBe(START + 300n);
  });

  it('measures the fall from the peak, not from the start', () => {
    // Up 500, then down 300. The drawdown is 300 even though equity never
    // went below where it began.
    const result = computeDrawdown([trip(500n, 1), trip(-300n, 2)], START);

    expect(result.maxDrawdown).toBe(300n);
    expect(result.troughAt).toBe(2);
  });

  it('keeps the deepest fall, not the most recent one', () => {
    const result = computeDrawdown(
      [trip(1_000n, 1), trip(-800n, 2), trip(900n, 3), trip(-100n, 4)],
      START,
    );

    expect(result.maxDrawdown).toBe(800n);
    expect(result.troughAt).toBe(2);
  });

  it('reports the fall as a share of the peak it fell from', () => {
    const result = computeDrawdown([trip(-1_000_000_000n, 1)], START);
    expect(result.maxDrawdownBps).toBe(1_000);
  });

  it('reads the log in time order regardless of how it arrives', () => {
    const ordered = computeDrawdown([trip(500n, 1), trip(-300n, 2)], START);
    const shuffled = computeDrawdown([trip(-300n, 2), trip(500n, 1)], START);

    expect(shuffled.maxDrawdown).toBe(ordered.maxDrawdown);
    expect(shuffled.curve.map((point) => point.at)).toEqual([1, 2]);
  });
});

describe('streaks', () => {
  it('counts the longest run of each', () => {
    const result = computeDrawdown(
      [trip(-1n, 1), trip(-1n, 2), trip(-1n, 3), trip(1n, 4), trip(1n, 5)],
      START,
    );

    expect(result.longestLosingStreak).toBe(3);
    expect(result.longestWinningStreak).toBe(2);
  });

  it('lets a break-even trade end a run without extending it', () => {
    const result = computeDrawdown([trip(1n, 1), trip(0n, 2), trip(1n, 3)], START);
    expect(result.longestWinningStreak).toBe(1);
  });

  it('has no streaks with no trades', () => {
    const result = computeDrawdown([], START);
    expect(result.longestLosingStreak).toBe(0);
    expect(result.curve).toHaveLength(0);
  });
});
