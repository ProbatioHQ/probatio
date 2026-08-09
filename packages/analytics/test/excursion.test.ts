import { describe, expect, it } from 'vitest';
import { PRICE_SCALE } from '@probatio/candles';
import { computeExcursion, summarizeExcursions } from '../src/excursion';
import type { RoundTrip } from '../src/roundtrips';

/** A price of `lamports` per token base unit. */
function price(lamports: number): bigint {
  return BigInt(lamports) * PRICE_SCALE;
}

function trip(overrides: Partial<RoundTrip> = {}): RoundTrip {
  const invested = overrides.invested ?? 1_000n;
  const proceeds = overrides.proceeds ?? 1_000n;
  return {
    mint: 'M',
    openedAt: 0,
    closedAt: 60_000,
    heldMs: 60_000,
    invested,
    proceeds,
    realized: proceeds - invested,
    feesPaid: 0n,
    buys: 1,
    sells: 1,
    peakTokens: 100n,
    tokensBought: 100n,
    tokensSold: 100n,
    trades: [],
    ...overrides,
  };
}

describe('average prices', () => {
  it('divides what went in by the tokens it bought', () => {
    const result = computeExcursion(
      trip({ invested: 1_000n, proceeds: 2_000n, tokensBought: 100n, tokensSold: 100n }),
      { high: price(30), low: price(5) },
    );

    expect(result.averageEntry).toBe(price(10));
    expect(result.averageExit).toBe(price(20));
    expect(result.returnBps).toBe(10_000);
  });

  it('reports a loss as a negative return', () => {
    const result = computeExcursion(trip({ invested: 1_000n, proceeds: 250n }), {
      high: price(11),
      low: price(2),
    });
    expect(result.returnBps).toBe(-7_500);
  });
});

describe('excursion against the range', () => {
  it('measures the best gain that was available', () => {
    // Entry at 10, high at 25. There was 150% on the table.
    const result = computeExcursion(trip({ invested: 1_000n, proceeds: 1_200n }), {
      high: price(25),
      low: price(9),
    });

    expect(result.mfeBps).toBe(15_000);
    expect(result.maeBps).toBe(1_000);
  });

  it('reports no adverse move when the price never went below the entry', () => {
    const result = computeExcursion(trip(), { high: price(20), low: price(10) });
    expect(result.maeBps).toBe(0);
  });

  it('reports no favourable move when the price never rose above the entry', () => {
    const result = computeExcursion(trip(), { high: price(10), low: price(4) });
    expect(result.mfeBps).toBe(0);
  });

  it('scores an entry at the exact low as perfect', () => {
    const result = computeExcursion(trip({ invested: 1_000n, tokensBought: 100n }), {
      high: price(30),
      low: price(10),
    });
    expect(result.entryEfficiencyBps).toBe(10_000);
  });

  it('scores an exit at the exact high as perfect', () => {
    const result = computeExcursion(
      trip({ invested: 1_000n, proceeds: 3_000n, tokensSold: 100n }),
      { high: price(30), low: price(10) },
    );
    expect(result.exitEfficiencyBps).toBe(10_000);
  });

  it('scores the middle of the range at half', () => {
    const result = computeExcursion(
      trip({ invested: 2_000n, proceeds: 2_000n, tokensBought: 100n, tokensSold: 100n }),
      { high: price(30), low: price(10) },
    );
    expect(result.entryEfficiencyBps).toBe(5_000);
    expect(result.exitEfficiencyBps).toBe(5_000);
  });

  it('clamps rather than claiming better than perfect', () => {
    // Fees are inside the average entry, so it can sit outside a range taken
    // from mid-prices. "111% efficient" would be an artefact, not a compliment.
    const result = computeExcursion(trip({ invested: 500n, tokensBought: 100n }), {
      high: price(30),
      low: price(10),
    });
    expect(result.entryEfficiencyBps).toBe(10_000);
  });

  it('has no opinion when the price never moved', () => {
    const result = computeExcursion(trip(), { high: price(10), low: price(10) });
    expect(result.entryEfficiencyBps).toBeNull();
    expect(result.exitEfficiencyBps).toBeNull();
  });
});

describe('summarising', () => {
  const window = { high: price(30), low: price(10) };

  it('averages only over trips that had a range to judge against', () => {
    const summary = summarizeExcursions([
      computeExcursion(trip(), window),
      computeExcursion(trip(), { high: price(10), low: price(10) }),
    ]);

    expect(summary.count).toBe(2);
    // The flat one contributes nothing rather than dragging the average to zero.
    expect(summary.averageEntryEfficiencyBps).toBe(10_000);
  });

  it('counts winners that were given back', () => {
    // Up 150% at the high, closed at a loss. This is the number that tells a
    // trader something they cannot see from a win rate.
    const gaveBack = computeExcursion(trip({ invested: 1_000n, proceeds: 800n }), {
      high: price(25),
      low: price(7),
    });
    const cleanLoss = computeExcursion(trip({ invested: 1_000n, proceeds: 800n }), {
      high: price(10),
      low: price(7),
    });

    const summary = summarizeExcursions([gaveBack, cleanLoss]);
    expect(summary.gaveBackWinners).toBe(1);
  });

  it('says nothing at all with nothing to summarise', () => {
    const summary = summarizeExcursions([]);
    expect(summary.averageEntryEfficiencyBps).toBeNull();
    expect(summary.gaveBackWinners).toBe(0);
  });
});
