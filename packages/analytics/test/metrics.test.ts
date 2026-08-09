import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../src/metrics';
import type { RoundTrip } from '../src/roundtrips';

function trip(realized: bigint, overrides: Partial<RoundTrip> = {}): RoundTrip {
  const invested = overrides.invested ?? 1_000_000_000n;
  return {
    mint: 'M',
    openedAt: 0,
    closedAt: 60_000,
    heldMs: 60_000,
    invested,
    proceeds: invested + realized,
    realized,
    feesPaid: 0n,
    buys: 1,
    sells: 1,
    peakTokens: 1_000n,
    tokensBought: 1_000n,
    tokensSold: 1_000n,
    trades: [],
    ...overrides,
  };
}

describe('counting outcomes', () => {
  it('splits wins, losses and scratches', () => {
    const metrics = computeMetrics([trip(100n), trip(-50n), trip(0n), trip(30n)]);

    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(1);
    expect(metrics.scratches).toBe(1);
    // 2 of 4, and the scratch counts against it. A break-even trade is not a win.
    expect(metrics.winRateBps).toBe(5_000);
  });

  it('has no win rate at all with nothing closed', () => {
    const metrics = computeMetrics([]);
    expect(metrics.winRateBps).toBeNull();
    expect(metrics.expectancy).toBeNull();
    expect(metrics.profitFactorBps).toBeNull();
  });

  it('adds up gross profit and gross loss separately', () => {
    const metrics = computeMetrics([trip(300n), trip(-100n), trip(-200n)]);

    expect(metrics.grossProfit).toBe(300n);
    expect(metrics.grossLoss).toBe(300n);
    expect(metrics.netPnl).toBe(0n);
    expect(metrics.profitFactorBps).toBe(10_000);
  });

  it('reports no profit factor when nothing was ever lost', () => {
    // Not zero. A trader who has never lost has an undefined ratio, and
    // rendering that as 0 would rank them last.
    const metrics = computeMetrics([trip(100n), trip(200n)]);
    expect(metrics.profitFactorBps).toBeNull();
    expect(metrics.winLossMultipleBps).toBeNull();
  });

  it('compares the average win against the average loss', () => {
    const metrics = computeMetrics([trip(300n), trip(500n), trip(-200n)]);

    expect(metrics.winSizes.average).toBe(400n);
    expect(metrics.lossSizes.average).toBe(200n);
    expect(metrics.winLossMultipleBps).toBe(20_000);
  });

  it('averages toward zero rather than away from it', () => {
    // -3 over 2 trips is -1.5. Reporting -2 would overstate the damage.
    const metrics = computeMetrics([trip(-1n), trip(-2n)]);
    expect(metrics.expectancy).toBe(-1n);
  });

  it('takes the median of an even count from the middle pair', () => {
    const metrics = computeMetrics([trip(10n), trip(20n), trip(30n), trip(40n)]);
    expect(metrics.winSizes.median).toBe(25n);
  });

  it('carries fees through', () => {
    const metrics = computeMetrics([
      trip(100n, { feesPaid: 25n }),
      trip(-100n, { feesPaid: 75n }),
    ]);
    expect(metrics.feesPaid).toBe(100n);
  });
});

describe('hold times', () => {
  it('separates how long winners were held from losers', () => {
    const metrics = computeMetrics([
      trip(100n, { heldMs: 10_000 }),
      trip(200n, { heldMs: 20_000 }),
      trip(-100n, { heldMs: 600_000 }),
    ]);

    expect(metrics.winnerHoldMs.average).toBe(15_000);
    expect(metrics.loserHoldMs.average).toBe(600_000);
    expect(metrics.holdMs.longest).toBe(600_000);
    expect(metrics.holdMs.shortest).toBe(10_000);
  });

  it('leaves a hold distribution empty rather than zero', () => {
    const metrics = computeMetrics([trip(100n)]);
    expect(metrics.loserHoldMs.count).toBe(0);
    expect(metrics.loserHoldMs.average).toBeNull();
  });
});

describe('size consistency', () => {
  it('is zero when every position was the same size', () => {
    const metrics = computeMetrics([
      trip(1n, { invested: 1_000n }),
      trip(1n, { invested: 1_000n }),
      trip(1n, { invested: 1_000n }),
    ]);
    expect(metrics.sizeConsistencyBps).toBe(0);
  });

  it('grows as sizes scatter', () => {
    const steady = computeMetrics([
      trip(1n, { invested: 900n }),
      trip(1n, { invested: 1_100n }),
    ]).sizeConsistencyBps!;

    const wild = computeMetrics([
      trip(1n, { invested: 100n }),
      trip(1n, { invested: 10_000n }),
    ]).sizeConsistencyBps!;

    expect(steady).toBeLessThan(wild);
    expect(steady).toBe(1_000);
  });

  it('says nothing about consistency from a single trade', () => {
    expect(computeMetrics([trip(1n)]).sizeConsistencyBps).toBeNull();
  });
});
