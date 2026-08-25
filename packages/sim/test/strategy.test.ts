import { describe, expect, it } from 'vitest';
import {
  StrategyRulesError,
  exitDecision,
  matchesEntry,
  needsBundle,
  needsHolders,
  needsCreatorHolding,
  parseStrategyRules,
  RULES_VERSION,
  sizeFor,
  DEPTH_CAP_BPS,
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
    hasTwitter: true,
    hasWebsite: true,
    creatorLaunches: 1,
    creatorHoldingBps: 0,
    bundledBps: 0,
    holders: 200,
    socialReuse: 1,
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

  /*
   * The conditions that describe the launcher rather than the price. Nobody
   * decides what to buy from a market cap alone, and these are the two this
   * site can already answer without buying data from anybody.
   */
  it('can require an X account and a website', () => {
    expect(matchesEntry({ requireTwitter: true }, candidate({ hasTwitter: true })).ok).toBe(true);
    const none = matchesEntry({ requireTwitter: true }, candidate({ hasTwitter: false }));
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.why).toContain('no X account');

    expect(matchesEntry({ requireWebsite: true }, candidate({ hasWebsite: false })).ok).toBe(false);
  });

  it('does not read unread metadata as an absent account', () => {
    // A token seconds old has no metadata yet, which is not the same as a token
    // that named nothing. Passing it would enter exactly the launches this
    // condition exists to avoid.
    const verdict = matchesEntry({ requireTwitter: true }, candidate({ hasTwitter: null }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain('not been read');
  });

  it('skips serial launchers', () => {
    const rule = { maxCreatorLaunches: 3 };
    expect(matchesEntry(rule, candidate({ creatorLaunches: 1 })).ok).toBe(true);
    expect(matchesEntry(rule, candidate({ creatorLaunches: 3 })).ok).toBe(true);

    const busy = matchesEntry(rule, candidate({ creatorLaunches: 14 }));
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.why).toContain('14 tokens');
  });

  it('does not guess at a creator it knows nothing about', () => {
    expect(matchesEntry({ maxCreatorLaunches: 3 }, candidate({ creatorLaunches: null })).ok).toBe(false);
  });

  it('ignores the launcher conditions nobody asked for', () => {
    // A token with no socials still matches a strategy that never mentioned them.
    expect(
      matchesEntry({ maxAgeSeconds: 90 }, candidate({ hasTwitter: false, hasWebsite: false })).ok,
    ).toBe(true);
  });

  /*
   * The one condition that costs a chain read, so the runner only asks it of
   * candidates that already passed everything free.
   */
  it('caps what the launcher is still holding', () => {
    const rule = { maxCreatorHoldingBps: 500 };
    expect(matchesEntry(rule, candidate({ creatorHoldingBps: 120 })).ok).toBe(true);

    const heavy = matchesEntry(rule, candidate({ creatorHoldingBps: 3_400 }));
    expect(heavy.ok).toBe(false);
    if (!heavy.ok) expect(heavy.why).toContain('34.0%');
  });

  it('treats an unread holding as unmet rather than as clean', () => {
    // Zero is the answer that lets a token through, so an unknown must never
    // read as one. A condition that fails open is worse than no condition.
    expect(matchesEntry({ maxCreatorHoldingBps: 500 }, candidate({ creatorHoldingBps: null })).ok)
      .toBe(false);
  });

  it('knows when a rule needs the read at all', () => {
    expect(needsCreatorHolding({ maxAgeSeconds: 90 })).toBe(false);
    expect(needsCreatorHolding({ maxCreatorHoldingBps: 500 })).toBe(true);
  });

  it('caps what went in the launch slot', () => {
    const rule = { maxBundleBps: 2_000 };
    expect(matchesEntry(rule, candidate({ bundledBps: 400 })).ok).toBe(true);

    const bundled = matchesEntry(rule, candidate({ bundledBps: 6_100 }));
    expect(bundled.ok).toBe(false);
    if (!bundled.ok) expect(bundled.why).toContain('61.0%');
  });

  it('treats an unread launch slot as unmet rather than as clean', () => {
    // Nothing bought in the launch slot and nothing known about it are opposite
    // facts. Only one of them is a token worth entering.
    expect(matchesEntry({ maxBundleBps: 2_000 }, candidate({ bundledBps: null })).ok).toBe(false);
    expect(needsBundle({ maxAgeSeconds: 90 })).toBe(false);
    expect(needsBundle({ maxBundleBps: 2_000 })).toBe(true);
  });

  it('requires a floor of real holders', () => {
    const rule = { minHolders: 50 };
    expect(matchesEntry(rule, candidate({ holders: 220 })).ok).toBe(true);

    const thin = matchesEntry(rule, candidate({ holders: 4 }));
    expect(thin.ok).toBe(false);
    if (!thin.ok) expect(thin.why).toContain('4 wallets');
  });

  it('treats an unread holder count as unmet', () => {
    expect(matchesEntry({ minHolders: 50 }, candidate({ holders: null })).ok).toBe(false);
    expect(needsHolders({ maxAgeSeconds: 90 })).toBe(false);
    expect(needsHolders({ minHolders: 50 })).toBe(true);
  });

  /*
   * The buildable half of "this account has shilled a pile of coins". Not what
   * it posted and deleted, which needs an archive nobody here keeps, but how
   * many launches in this site's own index name the same account.
   */
  it('catches an X account attached to a pile of tokens', () => {
    const rule = { maxSocialReuse: 3 };
    expect(matchesEntry(rule, candidate({ socialReuse: 1 })).ok).toBe(true);

    const serial = matchesEntry(rule, candidate({ socialReuse: 19 }));
    expect(serial.ok).toBe(false);
    if (!serial.ok) expect(serial.why).toContain('19 tokens');
  });

  it('has nothing to check when a token names no account', () => {
    expect(matchesEntry({ maxSocialReuse: 3 }, candidate({ socialReuse: null })).ok).toBe(false);
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

  it('reads the launcher conditions', () => {
    const parsed = parseStrategyRules(
      rules({ entry: { requireTwitter: true, requireWebsite: true, maxCreatorLaunches: 3 } }),
    );
    expect(parsed.entry.requireTwitter).toBe(true);
    expect(parsed.entry.maxCreatorLaunches).toBe(3);
  });

  it('treats an unticked box as a condition nobody set', () => {
    // False is not a condition. "I did not ask for an X account" must not become
    // "only tokens with no X account".
    const parsed = parseStrategyRules(
      rules({ entry: { maxAgeSeconds: 90, requireTwitter: false, requireWebsite: false } }),
    );
    expect(parsed.entry.requireTwitter).toBeUndefined();
    expect(parsed.entry.requireWebsite).toBeUndefined();
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

/* ---------------------------------------------------------------------------
 * Sizing by conviction
 * ------------------------------------------------------------------------ */

describe('what to stake on something that passed', () => {
  const FULL = 1_000_000_000n; // 1 SOL
  const FLOOR = 200_000_000n; // 0.2 SOL
  const ranged = { stakeLamports: FULL, minStakeLamports: FLOOR, maxOpenPositions: 3 };
  const flat = { stakeLamports: FULL, maxOpenPositions: 3 };

  /* Deep enough that the cap is never the binding constraint unless a test
     means it to be: two percent of 500 SOL is 10 SOL, well over FULL. */
  const deep = { liquidityLamports: 500_000_000_000n };

  it('sizes every entry the same when no floor is set', () => {
    const out = sizeFor(flat, { maxAgeSeconds: 900 }, candidate({ ageSeconds: 10, ...deep }));
    expect(out.lamports).toBe(FULL);
    expect(out.confidence).toBeNull();
  });

  /*
   * The whole point of the feature. Before this, both of these produced the
   * same bet, because the size was one number and a condition was a gate.
   */
  it('bets more on something that cleared by a mile than on something that scraped past', () => {
    const entry = { maxAgeSeconds: 1_000 };
    const easy = sizeFor(ranged, entry, candidate({ ageSeconds: 10, ...deep }));
    const scraped = sizeFor(ranged, entry, candidate({ ageSeconds: 995, ...deep }));

    expect(easy.lamports).toBeGreaterThan(scraped.lamports);
    expect(easy.confidence!).toBeGreaterThan(0.9);
    expect(scraped.confidence!).toBeLessThan(0.1);
  });

  it('never goes under the floor or over the ceiling', () => {
    const entry = { maxAgeSeconds: 1_000 };
    for (const age of [0, 1, 500, 999, 1_000]) {
      const out = sizeFor(ranged, entry, candidate({ ageSeconds: age, ...deep }));
      expect(out.lamports).toBeGreaterThanOrEqual(FLOOR);
      expect(out.lamports).toBeLessThanOrEqual(FULL);
    }
  });

  it('averages the conditions rather than letting the biggest numbers decide', () => {
    /*
     * Age is in seconds and market cap is in lamports. Scored raw, the market
     * cap would swamp everything else purely because its numbers are larger.
     */
    const entry = { maxAgeSeconds: 1_000, maxMarketCapLamports: 1_000_000_000_000n };
    const half = sizeFor(
      ranged,
      entry,
      candidate({ ageSeconds: 500, marketCapLamports: 500_000_000_000n, ...deep }),
    );
    expect(half.confidence!).toBeCloseTo(0.5, 2);
  });

  it('ignores the yes-or-no conditions, which have no margin', () => {
    // There is no such thing as clearing "names an X account" by a mile.
    const only = sizeFor(
      ranged,
      { requireTwitter: true, venue: 'curve' },
      candidate({ hasTwitter: true, ...deep }),
    );
    expect(only.confidence).toBeNull();
    expect(only.lamports).toBe(FULL);
  });

  /*
   * The guard that makes this safe rather than a way to lose more money
   * confidently. A take profit fires when a position is largest against its
   * pool, which is when leaving costs the most, so conviction must not be
   * allowed to walk a strategy into a size the pool cannot give back.
   */
  it('caps a confident bet against the pool, not against the balance', () => {
    const thin = candidate({ ageSeconds: 1, liquidityLamports: 10_000_000_000n }); // 10 SOL
    const out = sizeFor(ranged, { maxAgeSeconds: 1_000 }, thin);

    // Two percent of ten SOL is 0.2 SOL, which is under what full conviction
    // would otherwise have staked.
    expect(out.confidence!).toBeGreaterThan(0.9);
    expect(out.lamports).toBe((10_000_000_000n * BigInt(DEPTH_CAP_BPS)) / 10_000n);
    expect(out.lamports).toBeLessThan(FULL);
    expect(out.why).toContain("pool's depth");
  });

  it('lets the cap pull down to the floor but never through it', () => {
    // A pool so thin that two percent of it is less than the trader's own
    // floor. Their floor is their decision; the engine's impact ceiling is what
    // refuses a genuinely ruinous fill.
    const dust = candidate({ ageSeconds: 1, liquidityLamports: 1_000_000_000n }); // 1 SOL
    const out = sizeFor(ranged, { maxAgeSeconds: 1_000 }, dust);
    expect(out.lamports).toBe(FLOOR);
  });

  it('stays at the floor when the pool depth is not known', () => {
    // Board candidates carry no SOL-denominated depth. An uncapped raise is
    // exactly what the cap exists to prevent, so it does not raise.
    const unknown = candidate({ ageSeconds: 1, liquidityLamports: null });
    const out = sizeFor(ranged, { maxAgeSeconds: 1_000 }, unknown);
    expect(out.lamports).toBe(FLOOR);
    expect(out.confidence!).toBeGreaterThan(0.9);
    expect(out.why).toContain('not known here');
  });

  /*
   * The bug this pass found, and the one that would have quietly ruined the
   * feature. "Moved at least -20%" is an ordinary rule meaning the token has
   * not dumped more than a fifth, and dividing by a negative limit flips the
   * whole calculation. The first version shortcut that by treating any limit at
   * or below nought as cleared in full, which handed maximum conviction to a
   * token sitting exactly on the floor and dragged every average containing
   * such a condition to the top of the range.
   */
  it('scores a negative floor by how far past it the token actually got', () => {
    const entry = { minChangeBps: -2_000 };
    const barely = sizeFor(ranged, entry, candidate({ changeBps: -2_000, ...deep }));
    const comfortably = sizeFor(ranged, entry, candidate({ changeBps: 5_000, ...deep }));
    expect(barely.confidence!).toBeLessThan(0.1);
    expect(comfortably.confidence!).toBeGreaterThan(barely.confidence!);
    expect(barely.lamports).toBeLessThan(comfortably.lamports);
  });

  it('scores a negative ceiling the same way', () => {
    const entry = { maxChangeBps: -500 };
    const barely = sizeFor(ranged, entry, candidate({ changeBps: -500, ...deep }));
    const comfortably = sizeFor(ranged, entry, candidate({ changeBps: -9_000, ...deep }));
    expect(barely.confidence!).toBeLessThan(0.1);
    expect(comfortably.confidence!).toBeGreaterThan(0.9);
  });

  it('does not score a limit of nought, which has no margin to clear', () => {
    // "At most 0% bundled" is met or it is not. There is no clearing it well,
    // and nought has no magnitude to be a share of.
    const out = sizeFor(ranged, { maxBundleBps: 0 }, candidate({ bundledBps: 0, ...deep }));
    expect(out.confidence).toBeNull();
    expect(out.lamports).toBe(FULL);
  });

  it('still scores the other conditions when one of them is unscorable', () => {
    const out = sizeFor(
      ranged,
      { maxBundleBps: 0, maxAgeSeconds: 1_000 },
      candidate({ bundledBps: 0, ageSeconds: 500, ...deep }),
    );
    expect(out.confidence).toBeCloseTo(0.5, 2);
  });

  it('treats a floor at or above the ceiling as no range at all', () => {
    const same = sizeFor(
      { stakeLamports: FULL, minStakeLamports: FULL, maxOpenPositions: 3 },
      { maxAgeSeconds: 1_000 },
      candidate({ ageSeconds: 1, ...deep }),
    );
    expect(same.lamports).toBe(FULL);
    expect(same.confidence).toBeNull();
  });
});

describe('the smallest position, as written down', () => {
  it('round-trips through the stored shape', () => {
    const parsed = parseStrategyRules(
      rules({ size: { stakeLamports: '1000000000', minStakeLamports: '200000000', maxOpenPositions: 3 } }),
    );
    expect(parsed.size.minStakeLamports).toBe(200_000_000n);
    const back = readStoredRules(serializeStrategyRules(parsed), RULES_VERSION);
    expect(back.size.minStakeLamports).toBe(200_000_000n);
  });

  it('is absent when it was left empty, rather than stored as nought', () => {
    const parsed = parseStrategyRules(rules());
    expect(parsed.size.minStakeLamports).toBeUndefined();
    expect(serializeStrategyRules(parsed)).not.toContain('minStakeLamports');
  });

  it('refuses a floor that is not under the ceiling', () => {
    // Swapping them silently would be deciding for somebody what they meant.
    expect(() =>
      parseStrategyRules(
        rules({ size: { stakeLamports: '200000000', minStakeLamports: '500000000', maxOpenPositions: 3 } }),
      ),
    ).toThrow(StrategyRulesError);
  });
});
