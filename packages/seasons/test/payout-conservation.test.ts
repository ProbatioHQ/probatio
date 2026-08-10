import { describe, expect, it } from 'vitest';
import { distribute } from '../src/payout';
import { rulesetFor } from '../src/spec';

/**
 * The money has to add up, everywhere.
 *
 * The existing payout tests check named cases: a pot of one SOL, twenty
 * entrants, the boundary between bands. This sweeps instead, because the way a
 * split goes wrong is never at the number somebody chose to write a test for —
 * it is at a pot of three lamports across ten places, where every share floors
 * to zero and the remainder is the entire pot.
 *
 * A season pays out of a vault holding exactly the pot. Paying a lamport more
 * than went in is a transaction that fails for the last winner in the queue;
 * paying less strands money in an account nobody can empty. Both are silent
 * until somebody tries to claim.
 */

const RULES = rulesetFor(1);

/** Pots chosen to sit on every awkward edge rather than in the comfortable middle. */
const POTS = [
  0n,
  1n,
  2n,
  3n,
  7n,
  9_999n,
  10_000n,
  10_001n,
  // Either side of each payout band boundary.
  999_999_999n,
  1_000_000_000n,
  1_000_000_001n,
  4_999_999_999n,
  5_000_000_000n,
  5_000_000_001n,
  // Absurd, to catch anything that overflows or silently narrows.
  1_000_000_000_000_000_000n,
];

const ENTRANTS = [0, 1, 2, 3, 9, 10, 11, 19, 20, 21, 99, 100, 101, 5_000];

describe('a payout split conserves the pot', () => {
  it('never pays out more or less than the pot, at any size', () => {
    for (const pot of POTS) {
      for (const entrants of ENTRANTS) {
        const result = distribute(RULES, pot, entrants);
        const paid = result.payouts.reduce((sum, payout) => sum + payout.lamports, 0n);

        expect(
          result.house + paid,
          `pot ${pot} across ${entrants} entrants paid ${result.house + paid}`,
        ).toBe(entrants <= 0 || pot === 0n ? 0n : pot);
      }
    }
  });

  it('never assigns a negative or absent amount', () => {
    for (const pot of POTS) {
      for (const entrants of ENTRANTS) {
        for (const payout of distribute(RULES, pot, entrants).payouts) {
          expect(payout.lamports >= 0n).toBe(true);
          expect(Number.isInteger(payout.place)).toBe(true);
        }
      }
    }
  });

  it('never pays more places than there are entrants', () => {
    for (const pot of POTS) {
      for (const entrants of ENTRANTS) {
        const result = distribute(RULES, pot, entrants);
        // Paying a place nobody finished in means paying nobody, which on
        // chain means a claim that can never be proved.
        expect(result.payouts.length).toBeLessThanOrEqual(Math.max(0, entrants));
        expect(result.payouts.length).toBe(result.paidPlaces);
      }
    }
  });

  it('orders places from first downward with no gaps', () => {
    for (const pot of POTS) {
      for (const entrants of ENTRANTS) {
        const places = distribute(RULES, pot, entrants).payouts.map((p) => p.place);
        expect(places).toEqual(places.map((_, index) => index + 1));
      }
    }
  });

  it('never pays a later place more than an earlier one', () => {
    for (const pot of POTS) {
      for (const entrants of ENTRANTS) {
        const amounts = distribute(RULES, pot, entrants).payouts.map((p) => p.lamports);
        for (let i = 1; i < amounts.length; i += 1) {
          // First place absorbs the rounding remainder, so it can only ever
          // pull further ahead — never behind second.
          expect(amounts[i - 1]! >= amounts[i]!).toBe(true);
        }
      }
    }
  });

  it('keeps the house cut inside the pot', () => {
    for (const pot of POTS) {
      for (const entrants of ENTRANTS) {
        const result = distribute(RULES, pot, entrants);
        expect(result.house >= 0n).toBe(true);
        expect(result.house <= pot).toBe(true);
      }
    }
  });

  it('takes no cut from a sponsored prize', () => {
    // The house cut applies to what entrants paid, never to money put up as
    // the prize — taking a tenth of that would advertise more than it pays.
    const sponsoredOnly = distribute(RULES, 2_000_000_000n, 5, { houseBaseLamports: 0n });
    expect(sponsoredOnly.house).toBe(0n);

    const paid = sponsoredOnly.payouts.reduce((sum, p) => sum + p.lamports, 0n);
    expect(paid).toBe(2_000_000_000n);
  });

  it('refuses a negative pot rather than inventing a split for it', () => {
    expect(() => distribute(RULES, -1n, 5)).toThrow();
  });
});
