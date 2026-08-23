import { describe, expect, it } from 'vitest';
import {
  StrategyRulesError,
  exitDecision,
  matchesEntry,
  parseStrategyRules,
  readStoredRules,
  serializeStrategyRules,
  type Candidate,
  type StrategyRules,
} from '../src/strategy';

/**
 * The rules a hosted strategy is made of.
 *
 * Two things are being defended here. That a set of rules which cannot work is
 * refused at the point somebody writes it rather than discovered mid-season, and
 * that the decision to leave a position is one decision, taken in one place, so
 * a backtest and a live run cannot come to different conclusions about the same
 * rule.
 */

function rules(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entry: { maxAgeSeconds: 90 },
    size: { stakeLamports: '250000000', maxOpenPositions: 3 },
    exit: { takeProfitBps: 12_000, stopLossBps: 4_000, timeoutSeconds: 600 },
    ...over,
  };
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    mint: 'D3KxoUnQdZZUnQcpmxb9Ktb26rDndURseog6DPsVpump',
    ageSeconds: 45,
    liquidityLamports: 30_000_000_000n,
    marketCapLamports: 500_000_000_000n,
    changeBps: 2_500,
    graduated: false,
    ...over,
  };
}

describe('leaving a position', () => {
  const exit = { takeProfitBps: 12_000, stopLossBps: 4_000, timeoutSeconds: 600 };

  it('does nothing while the position is inside its bounds', () => {
    expect(exitDecision(exit, { movedBps: 500, heldSeconds: 60 })).toBeNull();
  });

  it('takes profit once a real exit clears the level', () => {
    expect(exitDecision(exit, { movedBps: 12_000, heldSeconds: 60 })).toBe('take_profit');
  });

  it('stops out on the way down', () => {
    expect(exitDecision(exit, { movedBps: -4_000, heldSeconds: 60 })).toBe('stop_loss');
  });

  it('gives up when the clock runs out', () => {
    expect(exitDecision(exit, { movedBps: 100, heldSeconds: 600 })).toBe('timeout');
  });

  /*
   * The pessimistic order, and the reason for it. One swap can carry a price
   * through both levels and only one of them can be true; assuming the move went
   * against you first is the right assumption about a moment nobody saw inside.
   */
  it('prefers the stop when a single move crosses both levels', () => {
    expect(exitDecision(exit, { movedBps: -9_000, heldSeconds: 1 })).toBe('stop_loss');
    const wide = { takeProfitBps: 100, stopLossBps: 100 };
    expect(exitDecision(wide, { movedBps: 5_000, heldSeconds: 1 })).toBe('take_profit');
  });

  it('ignores a level that was not set', () => {
    expect(exitDecision({ timeoutSeconds: 60 }, { movedBps: -9_000, heldSeconds: 5 })).toBeNull();
    expect(exitDecision({ stopLossBps: 4_000 }, { movedBps: 90_000, heldSeconds: 99_999 })).toBeNull();
  });
});

describe('whether a token qualifies', () => {
  const entry = { maxAgeSeconds: 90, minLiquidityLamports: 20_000_000_000n };

  it('accepts one that meets every condition', () => {
    expect(matchesEntry(entry, candidate())).toEqual({ ok: true });
  });

  it('says why it turned one down', () => {
    const verdict = matchesEntry(entry, candidate({ ageSeconds: 400 }));
    expect(verdict.ok).toBe(false);
    // An owner watching a strategy do nothing cannot otherwise tell unmet
    // conditions from a broken runner, and those are very different things.
    if (!verdict.ok) expect(verdict.why).toContain('400s old');
  });

  it('turns down a pool too thin to trade', () => {
    const verdict = matchesEntry(entry, candidate({ liquidityLamports: 1_000_000_000n }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('1.000 SOL');
  });

  it('honours the venue', () => {
    expect(matchesEntry({ venue: 'curve' }, candidate({ graduated: true })).ok).toBe(false);
    expect(matchesEntry({ venue: 'graduated' }, candidate({ graduated: false })).ok).toBe(false);
    expect(matchesEntry({ venue: 'any' }, candidate({ graduated: true })).ok).toBe(true);
  });

  /*
   * The one that would have quietly entered every dead token on the feed: a
   * strategy asking for a move above zero, against a token nobody has traded, if
   * "no history" were read as "flat".
   */
  it('does not read an absent move as a flat one', () => {
    const wantsMove = { minChangeBps: 1_000, changeWindowSeconds: 300 };
    const verdict = matchesEntry(wantsMove, candidate({ changeBps: null }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('not enough history');
  });

  it('checks the move when there is one', () => {
    const wantsMove = { minChangeBps: 1_000, changeWindowSeconds: 300 };
    expect(matchesEntry(wantsMove, candidate({ changeBps: 2_500 })).ok).toBe(true);
    expect(matchesEntry(wantsMove, candidate({ changeBps: 400 })).ok).toBe(false);
  });

  it('takes no conditions to mean anything qualifies', () => {
    expect(matchesEntry({}, candidate({ ageSeconds: 99_999 })).ok).toBe(true);
  });

  /*
   * The bug this pair exists for. The explore board reports depth and market cap
   * in dollars and the runner has no honest rate to convert them, so it says
   * null. Reported as nought instead, a ceiling would have matched every
   * graduated token on the feed — "market cap at most a hundred SOL" is
   * satisfied by nought — while a floor rejected all of them. A strategy meant
   * to buy small tokens would have bought the largest ones on the site.
   */
  it('does not read an unknown market cap as a small one', () => {
    const ceiling = { maxMarketCapLamports: 100_000_000_000n };
    expect(matchesEntry(ceiling, candidate({ marketCapLamports: null })).ok).toBe(false);
    expect(matchesEntry(ceiling, candidate({ marketCapLamports: 50_000_000_000n })).ok).toBe(true);
    expect(matchesEntry(ceiling, candidate({ marketCapLamports: 900_000_000_000n })).ok).toBe(false);
  });

  it('does not read unknown liquidity as a deep pool or a dry one', () => {
    const floor = { minLiquidityLamports: 20_000_000_000n };
    const verdict = matchesEntry(floor, candidate({ liquidityLamports: null }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('not known');
  });

  it('ignores an unknown figure no condition asked about', () => {
    // Not knowing a token's market cap is only a problem for a strategy that
    // cares about market caps.
    expect(
      matchesEntry({ maxAgeSeconds: 90 }, candidate({ marketCapLamports: null, liquidityLamports: null })).ok,
    ).toBe(true);
  });
});

describe('reading a set of rules', () => {
  it('accepts a workable one', () => {
    const parsed = parseStrategyRules(rules());
    expect(parsed.size.stakeLamports).toBe(250_000_000n);
    expect(parsed.exit.takeProfitBps).toBe(12_000);
    expect(parsed.entry.maxAgeSeconds).toBe(90);
  });

  /*
   * The blank-field trap. Three empty boxes is not a considered decision to buy
   * and hold for a fortnight, and refusing is the only reading that cannot cost
   * somebody a season.
   */
  it('refuses a strategy with no way out', () => {
    expect(() => parseStrategyRules(rules({ exit: {} }))).toThrow(/at least one way out/);
  });

  it('refuses conditions that can never both be true', () => {
    expect(() =>
      parseStrategyRules(rules({ entry: { minAgeSeconds: 300, maxAgeSeconds: 60 } })),
    ).toThrow(/nothing can match/);
    expect(() =>
      parseStrategyRules(
        rules({ entry: { minMarketCapLamports: '900', maxMarketCapLamports: '100' } }),
      ),
    ).toThrow(/nothing can match/);
  });

  it('refuses a move condition with nothing to measure it over', () => {
    expect(() => parseStrategyRules(rules({ entry: { minChangeBps: 500 } }))).toThrow(
      /needs a window/,
    );
  });

  it('refuses a position too small to be worth its own fees', () => {
    expect(() =>
      parseStrategyRules(rules({ size: { stakeLamports: '1000', maxOpenPositions: 1 } })),
    ).toThrow(StrategyRulesError);
  });

  it('refuses a position larger than the account could ever hold', () => {
    expect(() =>
      parseStrategyRules(
        rules({ size: { stakeLamports: '99000000000', maxOpenPositions: 1 } }),
      ),
    ).toThrow(StrategyRulesError);
  });

  it('refuses more open positions than it will run', () => {
    expect(() =>
      parseStrategyRules(rules({ size: { stakeLamports: '250000000', maxOpenPositions: 50 } })),
    ).toThrow(StrategyRulesError);
  });

  it('refuses a stop loss beyond a total loss', () => {
    expect(() => parseStrategyRules(rules({ exit: { stopLossBps: 12_000 } }))).toThrow(
      StrategyRulesError,
    );
  });

  it('refuses nonsense instead of coercing it', () => {
    expect(() => parseStrategyRules(null)).toThrow(StrategyRulesError);
    expect(() => parseStrategyRules({ entry: {}, size: {}, exit: {} })).toThrow(StrategyRulesError);
    expect(() =>
      parseStrategyRules(rules({ exit: { timeoutSeconds: 'soon' } })),
    ).toThrow(StrategyRulesError);
    expect(() => parseStrategyRules(rules({ entry: { venue: 'raydium' } }))).toThrow(
      /any, curve or graduated/,
    );
  });

  it('treats a blank box as a condition nobody set', () => {
    const parsed = parseStrategyRules(
      rules({ entry: { maxAgeSeconds: 90, minLiquidityLamports: '' } }),
    );
    expect(parsed.entry.minLiquidityLamports).toBeUndefined();
  });
});

describe('storing rules', () => {
  it('survives a round trip with its lamports intact', () => {
    const parsed = parseStrategyRules(
      rules({
        entry: { maxAgeSeconds: 90, minLiquidityLamports: '20000000000' },
      }),
    );
    const restored = readStoredRules(serializeStrategyRules(parsed), 1);

    expect(restored).toEqual<StrategyRules>(parsed);
    expect(restored.entry.minLiquidityLamports).toBe(20_000_000_000n);
  });

  /*
   * A row written by an older version of this file is exactly as untrusted as a
   * request body. Guessing at it is how a shape change becomes a runtime error
   * inside a loop that is placing orders.
   */
  it('refuses rules saved under a shape it does not know', () => {
    const stored = serializeStrategyRules(parseStrategyRules(rules()));
    expect(() => readStoredRules(stored, 2)).toThrow(/older format/);
  });

  it('refuses stored rules it cannot read at all', () => {
    expect(() => readStoredRules('{ not json', 1)).toThrow(/could not be read/);
  });

  it('re-validates what it reads back', () => {
    // Written straight past the validator, the way a bad migration would.
    expect(() =>
      readStoredRules('{"entry":{},"size":{"stakeLamports":"1","maxOpenPositions":1},"exit":{}}', 1),
    ).toThrow(StrategyRulesError);
  });
});
