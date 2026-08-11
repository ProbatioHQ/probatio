import { describe, expect, it } from 'vitest';
import { LAMPORTS_PER_SOL, PRACTICE_TIERS, creditFor, pricePerSol, tierFor } from '../src/store';

/**
 * The practice balance catalogue.
 *
 * Priced so that buying more costs less per SOL, which is the ordinary way a
 * larger purchase works and the thing a buyer will check first.
 */

describe('the sizes on sale', () => {
  it('sells the sizes the store offers and nothing else', () => {
    expect(PRACTICE_TIERS.map((tier) => tier.sol)).toEqual([1, 3, 10, 25, 50, 100]);
  });

  it('gets cheaper per SOL as the size goes up', () => {
    const rates = PRACTICE_TIERS.map((tier) => pricePerSol(tier));
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]!).toBeLessThan(rates[i - 1]!);
    }
  });

  it('credits exactly the size that was bought', () => {
    for (const tier of PRACTICE_TIERS) {
      expect(creditFor(tier)).toBe(BigInt(tier.sol) * LAMPORTS_PER_SOL);
    }
  });

  it('never gives the balance away', () => {
    // A tier priced at nothing would be free money, and the loop above would
    // still pass with a zero at the end.
    for (const tier of PRACTICE_TIERS) {
      expect(tier.priceLamports).toBeGreaterThan(0n);
    }
  });

  it('refuses a size it does not sell', () => {
    expect(tierFor(7)).toBeNull();
    expect(tierFor(0)).toBeNull();
    expect(tierFor(-10)).toBeNull();
    expect(tierFor(1_000_000)).toBeNull();
  });

  it('finds every size it does sell', () => {
    for (const tier of PRACTICE_TIERS) {
      expect(tierFor(tier.sol)).toEqual(tier);
    }
  });

  it('has a distinct price for every size', () => {
    // Two tiers at one price cannot be told apart on confirm, which recovers
    // the credit from the amount paid.
    const prices = PRACTICE_TIERS.map((tier) => tier.priceLamports.toString());
    expect(new Set(prices).size).toBe(prices.length);
  });
});
