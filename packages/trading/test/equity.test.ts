import { describe, expect, it } from 'vitest';
import { accountEquity, valuePosition, type ValuedPosition } from '../src/equity';

const PRICE_SCALE = 10n ** 18n;
const START = 10_000_000_000n;

function position(overrides: Partial<ValuedPosition> = {}): ValuedPosition {
  return {
    mint: 'mint',
    tokenAmount: 1_000n,
    costBasis: 1_000_000_000n,
    realizedPnl: 0n,
    value: 1_000_000_000n,
    ...overrides,
  };
}

describe('valuePosition', () => {
  it('marks a position to a price', () => {
    const valued = valuePosition(
      { mint: 'm', tokenAmount: 1_000n, costBasis: 500n, realizedPnl: 0n },
      2n * PRICE_SCALE,
      PRICE_SCALE,
    );
    expect(valued.value).toBe(2_000n);
  });

  it('values an empty position at nothing', () => {
    const valued = valuePosition(
      { mint: 'm', tokenAmount: 0n, costBasis: 0n, realizedPnl: 0n },
      PRICE_SCALE,
      PRICE_SCALE,
    );
    expect(valued.value).toBe(0n);
  });

  it('rounds the value down', () => {
    // A position must never be marked at more than it is worth, or a
    // leaderboard rewards rounding.
    const valued = valuePosition(
      { mint: 'm', tokenAmount: 3n, costBasis: 0n, realizedPnl: 0n },
      PRICE_SCALE / 2n,
      PRICE_SCALE,
    );
    expect(valued.value).toBe(1n);
  });
});

describe('accountEquity', () => {
  it('is just cash when nothing is held', () => {
    const equity = accountEquity(START, [], 0n, START);
    expect(equity.equity).toBe(START);
    expect(equity.totalPnl).toBe(0n);
    expect(equity.returnBps).toBe(0);
  });

  it('counts open positions at their current worth', () => {
    const equity = accountEquity(9_000_000_000n, [position({ value: 1_500_000_000n })], 0n, START);
    expect(equity.positionValue).toBe(1_500_000_000n);
    expect(equity.equity).toBe(10_500_000_000n);
  });

  it('separates realized from unrealized', () => {
    // Two different facts. One is money already banked; the other can still
    // evaporate, and merging them would flatter a position that has not been
    // exited.
    const equity = accountEquity(
      9_000_000_000n,
      [position({ costBasis: 1_000_000_000n, value: 1_500_000_000n })],
      250_000_000n,
      START,
    );

    expect(equity.unrealized).toBe(500_000_000n);
    expect(equity.realized).toBe(250_000_000n);
  });

  it('counts realized profit from positions already closed', () => {
    // A trader who made money and exited must not appear to have made nothing.
    const equity = accountEquity(11_000_000_000n, [], 1_000_000_000n, START);
    expect(equity.realized).toBe(1_000_000_000n);
    expect(equity.totalPnl).toBe(1_000_000_000n);
  });

  it('reports a gain in basis points', () => {
    const equity = accountEquity(11_000_000_000n, [], 1_000_000_000n, START);
    expect(equity.returnBps).toBe(1_000);
  });

  it('reports a loss as a negative', () => {
    const equity = accountEquity(9_000_000_000n, [], -1_000_000_000n, START);
    expect(equity.totalPnl).toBe(-1_000_000_000n);
    expect(equity.returnBps).toBe(-1_000);
  });

  it('truncates a gain rather than rounding it up', () => {
    // Never show a trader a return they have not quite made.
    const equity = accountEquity(START + 1n, [], 0n, START);
    expect(equity.returnBps).toBe(0);
  });

  it('handles a doubling', () => {
    const equity = accountEquity(20_000_000_000n, [], 0n, START);
    expect(equity.returnBps).toBe(10_000);
  });

  it('handles a wipeout', () => {
    const equity = accountEquity(0n, [], -START, START);
    expect(equity.returnBps).toBe(-10_000);
  });

  it('sums several positions', () => {
    const equity = accountEquity(
      1_000_000_000n,
      [
        position({ mint: 'a', costBasis: 2_000_000_000n, value: 3_000_000_000n }),
        position({ mint: 'b', costBasis: 4_000_000_000n, value: 1_000_000_000n }),
      ],
      0n,
      START,
    );

    expect(equity.positionValue).toBe(4_000_000_000n);
    expect(equity.equity).toBe(5_000_000_000n);
    expect(equity.unrealized).toBe(-2_000_000_000n);
  });

  it('does not divide by a zero starting balance', () => {
    expect(accountEquity(100n, [], 0n, 0n).returnBps).toBe(0);
  });

  it('is the number a season ranks on', () => {
    // Equity, not cash. A trader holding a winner is ahead of one holding
    // nothing, even before they sell.
    const holding = accountEquity(0n, [position({ value: 15_000_000_000n })], 0n, START);
    const sitting = accountEquity(START, [], 0n, START);
    expect(holding.equity).toBeGreaterThan(sitting.equity);
  });
});
