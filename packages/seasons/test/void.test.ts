import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOID_POLICY,
  VoidError,
  assessVoid,
  explainCondition,
  refunds,
  voidableNow,
  type VoidMeasurements,
} from '../src/void';

function measured(overrides: Partial<VoidMeasurements> = {}): VoidMeasurements {
  return {
    feedOutageMinutes: 0,
    chainHaltMinutes: 0,
    uncommittedTrades: 0,
    irreproducibleTrades: 0,
    engineVersions: [1],
    declaredEngineVersion: 1,
    ...overrides,
  };
}

describe('a season that counts', () => {
  it('stands when nothing went wrong', () => {
    const verdict = assessVoid(measured());
    expect(verdict.isVoid).toBe(false);
    expect(verdict.conditions).toEqual([]);
  });

  it('stands through an ordinary bad afternoon', () => {
    // A policy that voided on any interruption would void every season.
    const verdict = assessVoid(measured({ feedOutageMinutes: 30, chainHaltMinutes: 5 }));
    expect(verdict.isVoid).toBe(false);
  });

  it('stands exactly at the threshold', () => {
    const verdict = assessVoid(
      measured({ feedOutageMinutes: DEFAULT_VOID_POLICY.maxFeedOutageMinutes }),
    );
    expect(verdict.isVoid).toBe(false);
  });

  it('stands with no trades at all', () => {
    expect(assessVoid(measured({ engineVersions: [] })).isVoid).toBe(false);
  });

  it('reports every measurement, not only the ones that fired', () => {
    // The report is the evidence. Publishing only breaches would mean taking
    // our word for the rest.
    const verdict = assessVoid(measured());
    expect(verdict.report).toHaveLength(5);
    expect(verdict.report.every((row) => row.breached === false)).toBe(true);
  });
});

describe('a season that does not', () => {
  it('voids on a long feed outage', () => {
    const verdict = assessVoid(measured({ feedOutageMinutes: 121 }));
    expect(verdict.isVoid).toBe(true);
    expect(verdict.conditions).toEqual(['feed_outage']);
  });

  it('voids when the chain stopped', () => {
    expect(assessVoid(measured({ chainHaltMinutes: 61 })).conditions).toEqual(['chain_halt']);
  });

  it('voids on a single uncommitted trade', () => {
    // A trade nobody can verify is the one thing this product cannot ship.
    expect(assessVoid(measured({ uncommittedTrades: 1 })).conditions).toEqual([
      'uncommitted_trades',
    ]);
  });

  it('voids on a single trade that will not rebuild', () => {
    expect(assessVoid(measured({ irreproducibleTrades: 1 })).conditions).toEqual([
      'irreproducible_trades',
    ]);
  });

  it('voids when the engine changed mid-season', () => {
    // Results produced under two different engines are not comparable to each
    // other, never mind to another season.
    expect(assessVoid(measured({ engineVersions: [1, 2] })).conditions).toEqual(['engine_changed']);
  });

  it('voids when trades ran on an engine the season never declared', () => {
    expect(
      assessVoid(measured({ engineVersions: [2], declaredEngineVersion: 1 })).conditions,
    ).toEqual(['engine_changed']);
  });

  it('names every condition that fired', () => {
    const verdict = assessVoid(
      measured({ feedOutageMinutes: 999, uncommittedTrades: 4, engineVersions: [1, 3] }),
    );
    expect(verdict.conditions).toEqual(['feed_outage', 'uncommitted_trades', 'engine_changed']);
  });

  it('is void or not, never partly', () => {
    // No adjusted standings, no replay. A replay's result is whatever the
    // person running it says it is. One uncommitted trade is over the default
    // limit of zero, so this must actually void; asserting only that the field
    // is a boolean would pass even if assessVoid always returned false.
    const verdict = assessVoid(measured({ uncommittedTrades: 1 }));
    expect(verdict.isVoid).toBe(true);
  });
});

describe('the bound that makes this safe', () => {
  it('allows voiding before the results are on chain', () => {
    expect(voidableNow(null)).toBe(true);
  });

  it('refuses to void a finalized season', () => {
    // Without this, every condition above is a way to cancel a result somebody
    // dislikes after seeing it.
    expect(voidableNow(1_700_000_000_000)).toBe(false);
  });
});

describe('unwinding', () => {
  it('returns exactly what each trader paid', () => {
    const result = refunds([
      { trader: 'a', paid: 50_000_000n },
      { trader: 'b', paid: 50_000_000n },
    ]);
    expect(result).toEqual([
      { trader: 'a', lamports: 50_000_000n },
      { trader: 'b', lamports: 50_000_000n },
    ]);
  });

  it('takes no house cut', () => {
    // Voiding a season must never be a way to earn from failure.
    const paid = [{ trader: 'a', paid: 50_000_000n }, { trader: 'b', paid: 50_000_000n }];
    const returned = refunds(paid).reduce((sum, refund) => sum + refund.lamports, 0n);
    expect(returned).toBe(paid.reduce((sum, entry) => sum + entry.paid, 0n));
  });

  it('unwinds an empty season without complaint', () => {
    expect(refunds([])).toEqual([]);
  });

  it('refuses a negative entry', () => {
    expect(() => refunds([{ trader: 'a', paid: -1n }])).toThrow(VoidError);
  });
});

describe('saying why', () => {
  it('has a sentence for every condition', () => {
    for (const condition of [
      'feed_outage',
      'chain_halt',
      'uncommitted_trades',
      'irreproducible_trades',
      'engine_changed',
    ] as const) {
      expect(explainCondition(condition).length).toBeGreaterThan(20);
    }
  });
});
