import { describe, expect, it } from 'vitest';
import { computeDrawdown, computeMetrics, computeTimeOfDay, summarizeExcursions } from '@probatio/analytics';
import type { RoundTrip } from '@probatio/analytics';
import { buildBrief, formatBps, formatDuration, formatSol } from '../src/brief';

function trip(realized: bigint, openedAt = 0): RoundTrip {
  const invested = 1_000_000_000n;
  return {
    mint: 'M',
    openedAt,
    closedAt: openedAt + 60_000,
    heldMs: 60_000,
    invested,
    proceeds: invested + realized,
    realized,
    feesPaid: 12_500_000n,
    buys: 1,
    sells: 1,
    peakTokens: 1n,
    tokensBought: 1n,
    tokensSold: 1n,
    trades: [],
  };
}

function briefFor(trips: readonly RoundTrip[]) {
  return buildBrief({
    metrics: computeMetrics(trips),
    drawdown: computeDrawdown(trips, 10_000_000_000n),
    timeOfDay: computeTimeOfDay(trips),
    excursions: summarizeExcursions([]),
  });
}

describe('formatting', () => {
  it('renders lamports as SOL without floating point', () => {
    expect(formatSol(1_000_000_000n)).toBe('1.000 SOL');
    expect(formatSol(1_234_500_000n)).toBe('1.234 SOL');
    expect(formatSol(-2_340_000_000n)).toBe('-2.340 SOL');
    expect(formatSol(0n)).toBe('0.000 SOL');
  });

  it('keeps the sign on a small negative', () => {
    // Truncating this to "0.000 SOL" would drop the minus and report a loss
    // as break-even.
    expect(formatSol(-1_000_000n)).toBe('-0.001 SOL');
  });

  it('renders basis points as a percentage', () => {
    expect(formatBps(10_000)).toBe('100.0%');
    expect(formatBps(3_800)).toBe('38.0%');
    expect(formatBps(-2_500)).toBe('-25.0%');
    expect(formatBps(0)).toBe('0.0%');
  });

  it('renders durations at a useful scale', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(600_000)).toBe('10m');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(72 * 3_600_000)).toBe('3d');
  });
});

describe('building the brief', () => {
  it('omits a fact the record cannot support', () => {
    // Every trade won, so there is no average loss. A zero here would have the
    // coach explain a loss that never happened.
    const brief = briefFor([trip(100n), trip(200n), trip(300n), trip(400n), trip(500n)]);
    const keys = brief.facts.map((fact) => fact.key);

    expect(keys).toContain('averageWin');
    expect(keys).not.toContain('averageLoss');
    expect(keys).not.toContain('profitFactorBps');
  });

  it('says when there is not enough history', () => {
    expect(briefFor([trip(1n)]).sufficient).toBe(false);
    expect(briefFor([]).sufficient).toBe(false);
    expect(briefFor([trip(1n), trip(1n), trip(1n), trip(1n), trip(1n)]).sufficient).toBe(true);
  });

  it('never hands the model a raw number', () => {
    const brief = briefFor([trip(100n), trip(-200n), trip(300n), trip(-50n), trip(10n)]);
    for (const fact of brief.facts) {
      expect(typeof fact.value).toBe('string');
      expect(fact.value.length).toBeGreaterThan(0);
    }
  });

  it('carries the win rate with its counts', () => {
    const brief = briefFor([trip(100n), trip(-100n), trip(100n), trip(-100n), trip(100n)]);
    const winRate = brief.facts.find((fact) => fact.key === 'winRateBps');
    expect(winRate?.value).toBe('60.0% (3 of 5)');
  });

  it('has no facts at all from an empty record beyond the count', () => {
    const brief = briefFor([]);
    expect(brief.facts.map((fact) => fact.key)).toEqual(['trips', 'netPnl', 'feesPaid']);
  });
});
