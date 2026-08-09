import { describe, expect, it } from 'vitest';
import {
  RULESET_BYTES,
  RulesetError,
  encodeRuleset,
  rulesetHashHex,
  validateRuleset,
} from '../src/ruleset';
import type { Ruleset } from '../src/ruleset';
import { rulesetFor } from '../src/spec';

function rules(overrides: Partial<Ruleset> = {}): Ruleset {
  return { ...rulesetFor(1), ...overrides };
}

describe('encoding', () => {
  it('is the same length whatever the rules say', () => {
    // No length-dependent boundaries, so no two different rulesets can be made
    // to serialize identically by shifting one.
    expect(encodeRuleset(rules())).toHaveLength(RULESET_BYTES);
    expect(encodeRuleset(rules({ bands: [{ minPotLamports: 0n, sharesBps: [10_000] }] }))).toHaveLength(
      RULESET_BYTES,
    );
  });

  it('is deterministic', () => {
    expect(rulesetHashHex(rules())).toBe(rulesetHashHex(rules()));
  });

  it('produces a 32-byte hash', () => {
    expect(rulesetHashHex(rules())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('what changes the hash', () => {
  const base = rulesetHashHex(rules());

  it('changes when the entry cost changes', () => {
    expect(rulesetHashHex(rules({ entryCost: 1n }))).not.toBe(base);
  });

  it('changes when the house cut changes', () => {
    expect(rulesetHashHex(rules({ houseBps: 999 }))).not.toBe(base);
  });

  it('changes when the simulation conditions change', () => {
    // Latency and slippage are what make a result reproducible. A season whose
    // conditions moved without its hash moving would be unverifiable.
    expect(rulesetHashHex(rules({ latencyMs: 601 }))).not.toBe(base);
    expect(rulesetHashHex(rules({ slippageBps: 1_001 }))).not.toBe(base);
    expect(rulesetHashHex(rules({ maxPriceImpactBps: 4_999 }))).not.toBe(base);
    expect(rulesetHashHex(rules({ engineVersion: 2 }))).not.toBe(base);
  });

  it('changes when the payout shape changes', () => {
    expect(
      rulesetHashHex(
        rules({
          bands: [
            { minPotLamports: 0n, sharesBps: [10_000] },
            { minPotLamports: 1_000_000_000n, sharesBps: [6_000, 4_000] },
            { minPotLamports: 5_000_000_000n, sharesBps: [3_000, 1_800, 1_200, 1_000, 500, 500, 500, 500, 500, 500] },
          ],
        }),
      ),
    ).not.toBe(base);
  });

  it('changes when a band threshold moves', () => {
    const moved = rules().bands.map((band, index) =>
      index === 1 ? { ...band, minPotLamports: band.minPotLamports + 1n } : band,
    );
    expect(rulesetHashHex(rules({ bands: moved }))).not.toBe(base);
  });

  it('changes between season one and the ones after it', () => {
    // Season 1 runs a week, later seasons a fortnight.
    expect(rulesetHashHex(rulesetFor(2))).not.toBe(rulesetHashHex(rulesetFor(1)));
  });

  it('does not change for a different ordinal alone once past the first', () => {
    // Ordinal is in the hash, so it does change. Stated as a test because the
    // alternative reading — that seasons 2 and 3 share a hash — would be wrong.
    expect(rulesetHashHex(rulesetFor(2))).not.toBe(rulesetHashHex(rulesetFor(3)));
  });
});

describe('rules that make no sense', () => {
  it('refuses a season that never ends', () => {
    expect(() => validateRuleset(rules({ durationMs: 0 }))).toThrow(RulesetError);
  });

  it('refuses an entry window longer than the season', () => {
    expect(() => validateRuleset(rules({ entryWindowMs: 999 * 86_400_000 }))).toThrow(RulesetError);
  });

  it('refuses a starting balance of nothing', () => {
    expect(() => validateRuleset(rules({ startingBalance: 0n }))).toThrow(RulesetError);
  });

  it('refuses shares that do not total a hundred percent', () => {
    // A band that totals less loses money; one that totals more invents it.
    expect(() =>
      validateRuleset(rules({ bands: [{ minPotLamports: 0n, sharesBps: [5_000, 4_000] }] })),
    ).toThrow(/10000/);
    expect(() =>
      validateRuleset(rules({ bands: [{ minPotLamports: 0n, sharesBps: [6_000, 5_000] }] })),
    ).toThrow(/10000/);
  });

  it('refuses a paid place that is paid nothing', () => {
    expect(() =>
      validateRuleset(rules({ bands: [{ minPotLamports: 0n, sharesBps: [10_000, 0] }] })),
    ).toThrow(RulesetError);
  });

  it('refuses bands out of order', () => {
    expect(() =>
      validateRuleset(
        rules({
          bands: [
            { minPotLamports: 5_000_000_000n, sharesBps: [10_000] },
            { minPotLamports: 0n, sharesBps: [10_000] },
          ],
        }),
      ),
    ).toThrow(/ordered/);
  });

  it('refuses a first band that does not start at zero', () => {
    // Otherwise a pot below the first threshold pays nobody at all.
    expect(() =>
      validateRuleset(rules({ bands: [{ minPotLamports: 1n, sharesBps: [10_000] }] })),
    ).toThrow(/zero/);
  });

  it('refuses a house cut over a hundred percent', () => {
    expect(() => validateRuleset(rules({ houseBps: 10_001 }))).toThrow(RulesetError);
  });
});

describe('the locked spec', () => {
  it('is valid', () => {
    expect(() => validateRuleset(rulesetFor(1))).not.toThrow();
    expect(() => validateRuleset(rulesetFor(2))).not.toThrow();
  });

  it('runs season one for a week and later ones for a fortnight', () => {
    expect(rulesetFor(1).durationMs).toBe(7 * 86_400_000);
    expect(rulesetFor(2).durationMs).toBe(14 * 86_400_000);
  });

  it('closes entries after 48 hours', () => {
    expect(rulesetFor(1).entryWindowMs).toBe(2 * 86_400_000);
  });

  it('starts everybody with ten SOL and charges 0.05', () => {
    expect(rulesetFor(1).startingBalance).toBe(10_000_000_000n);
    expect(rulesetFor(1).entryCost).toBe(50_000_000n);
  });

  it('scores on return alone', () => {
    // Risk-adjusted scoring is dead: with no minimum trade count, one trade
    // gives almost no drawdown and therefore a near-infinite score.
    expect(rulesetFor(1).scoring).toBe('highest_return');
  });
});
