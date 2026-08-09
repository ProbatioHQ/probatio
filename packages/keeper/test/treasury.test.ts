import { describe, expect, it } from 'vitest';
import {
  RECORD_RENT_LAMPORTS,
  SIGNATURE_FEE_LAMPORTS,
  checkTreasury,
  coversItsCosts,
  estimateSeasonCost,
} from '../src/treasury';

const SOL = 1_000_000_000n;

describe('what a season costs to record', () => {
  it('charges rent once per trader and a fee per commit', () => {
    const cost = estimateSeasonCost({ traders: 10, tradesEach: 512, batchSize: 256 });

    expect(cost.records).toBe(10);
    expect(cost.commits).toBe(20);
    expect(cost.rentLamports).toBe(10n * RECORD_RENT_LAMPORTS);
    expect(cost.feeLamports).toBe(20n * SIGNATURE_FEE_LAMPORTS);
  });

  it('is dominated by rent, not by activity', () => {
    // A trader who makes one trade costs almost exactly as much to record as
    // one who makes a thousand. Worth knowing before optimising the wrong end.
    const quiet = estimateSeasonCost({ traders: 100, tradesEach: 1, batchSize: 256 });
    const busy = estimateSeasonCost({ traders: 100, tradesEach: 1_000, batchSize: 256 });

    expect(busy.totalLamports - quiet.totalLamports).toBeLessThan(quiet.rentLamports / 50n);
  });

  it('rounds a partial batch up to a whole commit', () => {
    // Two hundred and fifty seven trades is two commits, not one and a bit.
    expect(estimateSeasonCost({ traders: 1, tradesEach: 257, batchSize: 256 }).commits).toBe(2);
  });

  it('charges nothing for a season nobody joined', () => {
    expect(estimateSeasonCost({ traders: 0, tradesEach: 100, batchSize: 256 }).totalLamports).toBe(0n);
  });

  it('still charges rent for a trader who never traded enough to fill a batch', () => {
    const cost = estimateSeasonCost({ traders: 1, tradesEach: 1, batchSize: 256 });
    expect(cost.commits).toBe(1);
    expect(cost.totalLamports).toBe(RECORD_RENT_LAMPORTS + SIGNATURE_FEE_LAMPORTS);
  });

  it('survives a nonsense batch size rather than dividing by zero', () => {
    expect(() => estimateSeasonCost({ traders: 5, tradesEach: 10, batchSize: 0 })).not.toThrow();
  });
});

describe('whether the wallet can finish', () => {
  const remaining = { traders: 100, tradesEach: 500, batchSize: 256 };

  it('is happy with the margin held', () => {
    const check = checkTreasury({ balanceLamports: 1n * SOL, remaining });
    expect(check.verdict).toBe('ok');
    expect(check.shortfallLamports).toBe(0n);
  });

  it('warns while it can still be fixed cheaply', () => {
    // Above the estimate, inside the margin. The moment to act.
    const estimate = estimateSeasonCost(remaining);
    const check = checkTreasury({ balanceLamports: estimate.totalLamports + 1n, remaining });

    expect(check.verdict).toBe('low');
    expect(check.shortfallLamports).toBeGreaterThan(0n);
  });

  it('calls a real shortfall what it is', () => {
    const check = checkTreasury({ balanceLamports: 1_000n, remaining });
    expect(check.verdict).toBe('insufficient');
    expect(check.detail).toContain('void');
  });

  it('says how many more traders it can afford', () => {
    // The number that answers "can we open entries to more people".
    const check = checkTreasury({
      balanceLamports: 10n * RECORD_RENT_LAMPORTS,
      remaining: { traders: 100, tradesEach: 10, batchSize: 256 },
    });
    expect(check.tradersAffordable).toBe(9);
  });

  it('holds a margin because a season is not obliged to be average', () => {
    const estimate = estimateSeasonCost(remaining);
    const check = checkTreasury({ balanceLamports: 0n, remaining });
    expect(check.requiredLamports).toBeGreaterThan(estimate.totalLamports);
  });

  it('honours a caller who wants a different margin', () => {
    const tight = checkTreasury({ balanceLamports: 1n * SOL, remaining, marginBps: 100_000 });
    expect(tight.verdict).not.toBe('ok');
  });

  it('is fine with nothing left to do', () => {
    const check = checkTreasury({
      balanceLamports: 0n,
      remaining: { traders: 0, tradesEach: 0, batchSize: 256 },
    });
    expect(check.verdict).toBe('ok');
  });
});

describe('whether a season pays for itself', () => {
  const cost = estimateSeasonCost({ traders: 500, tradesEach: 200, batchSize: 256 });

  it('is covered at scale', () => {
    // 500 entries at 0.05 SOL is a 25 SOL pot; a tenth of that is far more
    // than the cost of recording it.
    const result = coversItsCosts(25n * SOL, 1_000, 1n * SOL, cost);
    expect(result.covered).toBe(true);
  });

  it('is not covered below the house threshold', () => {
    // Deliberate: no cut is taken from a small pot, so a small season is
    // recorded at a loss by design rather than by accident.
    const small = estimateSeasonCost({ traders: 10, tradesEach: 50, batchSize: 256 });
    const result = coversItsCosts(500_000_000n, 1_000, 1n * SOL, small);

    expect(result.revenueLamports).toBe(0n);
    expect(result.covered).toBe(false);
  });

  it('takes the cut on the whole pot once past the threshold', () => {
    const result = coversItsCosts(2n * SOL, 1_000, 1n * SOL, cost);
    expect(result.revenueLamports).toBe(200_000_000n);
  });
});
