import { describe, expect, it } from 'vitest';
import { bandFor, distribute, houseCut, nextBand } from '../src/payout';
import { ENTRY_COST, LAMPORTS_PER_SOL, rulesetFor } from '../src/spec';

const rules = rulesetFor(1);

/** A pot of exactly `entrants` paid entries. */
function pot(entrants: number): bigint {
  return ENTRY_COST * BigInt(entrants);
}

describe('choosing a band', () => {
  it('pays the winner alone while the pot is small', () => {
    expect(bandFor(rules, pot(5)).sharesBps).toEqual([10_000]);
  });

  it('starts paying three at a full SOL', () => {
    expect(bandFor(rules, LAMPORTS_PER_SOL).sharesBps).toHaveLength(3);
  });

  it('stays on the lower band one lamport short', () => {
    expect(bandFor(rules, LAMPORTS_PER_SOL - 1n).sharesBps).toHaveLength(1);
  });

  it('pays ten over five SOL', () => {
    expect(bandFor(rules, 5n * LAMPORTS_PER_SOL).sharesBps).toHaveLength(10);
  });

  it('names the pot the next band needs', () => {
    expect(nextBand(rules, pot(5))?.minPotLamports).toBe(LAMPORTS_PER_SOL);
    expect(nextBand(rules, 6n * LAMPORTS_PER_SOL)).toBeNull();
  });
});

describe('the house cut', () => {
  it('takes nothing from a small pot', () => {
    // Under a hundred dollars, a tenth is worth less than it costs in goodwill.
    expect(houseCut(rules, pot(10))).toBe(0n);
  });

  it('takes nothing at exactly the threshold', () => {
    expect(houseCut(rules, LAMPORTS_PER_SOL)).toBe(0n);
  });

  it('takes a tenth once past it', () => {
    expect(houseCut(rules, 2n * LAMPORTS_PER_SOL)).toBe(LAMPORTS_PER_SOL / 5n);
  });
});

describe('splitting the pot', () => {
  it('gives a lone entrant exactly what they paid', () => {
    // The clean case the threshold exists to protect.
    const result = distribute(rules, pot(1), 1);
    expect(result.house).toBe(0n);
    expect(result.payouts).toEqual([{ place: 1, lamports: ENTRY_COST }]);
  });

  it('balances exactly at every size', () => {
    // Every lamport in is paid out or taken. Dust left behind is a vault that
    // cannot be emptied; dust invented is a transfer that fails.
    for (const entrants of [1, 2, 3, 7, 19, 20, 21, 50, 99, 100, 101, 337, 1_000]) {
      const result = distribute(rules, pot(entrants), entrants);
      const paid = result.payouts.reduce((sum, payout) => sum + payout.lamports, 0n);
      expect(paid + result.house).toBe(pot(entrants));
    }
  });

  it('pays places in descending order', () => {
    const result = distribute(rules, pot(200), 200);
    for (let index = 1; index < result.payouts.length; index += 1) {
      expect(result.payouts[index]!.lamports).toBeLessThanOrEqual(
        result.payouts[index - 1]!.lamports,
      );
    }
  });

  it('gives the rounding dust to first place', () => {
    // Floored shares leave a few lamports. Spreading them would need another
    // rule to say where it stops; leaving them strands money forever.
    const result = distribute(rules, 1_000_000_001n, 3);
    const paid = result.payouts.reduce((sum, payout) => sum + payout.lamports, 0n);
    expect(paid).toBe(result.distributable);
  });

  it('pays nobody when nobody entered', () => {
    const result = distribute(rules, 0n, 0);
    expect(result.payouts).toEqual([]);
    expect(result.house).toBe(0n);
  });

  it('renormalizes when there are fewer entrants than places', () => {
    // Otherwise the shares of the places that do not exist stay in the vault.
    const result = distribute(rules, 2n * LAMPORTS_PER_SOL, 2);
    const paid = result.payouts.reduce((sum, payout) => sum + payout.lamports, 0n);

    expect(result.paidPlaces).toBe(2);
    expect(paid + result.house).toBe(2n * LAMPORTS_PER_SOL);
  });

  it('keeps the ratio between places when it renormalizes', () => {
    // 55 and 30 of the original band, rescaled, is still roughly 65/35.
    const result = distribute(rules, 2n * LAMPORTS_PER_SOL, 2);
    const [first, second] = result.payouts;
    const ratioBps = Number((first!.lamports * 10_000n) / (first!.lamports + second!.lamports));

    expect(ratioBps).toBeGreaterThan(6_400);
    expect(ratioBps).toBeLessThan(6_600);
  });

  it('refuses a negative pot', () => {
    expect(() => distribute(rules, -1n, 1)).toThrow();
  });
});
