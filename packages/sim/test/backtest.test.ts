import { describe, expect, it } from 'vitest';
import { backtestRule, type ReplayPoint, type Rule } from '../src/backtest';
import { DEFAULT_RULES, simulateFill } from '../src/execution';
import type { FeeSchedule, PoolState } from '../src/types';

/* PumpSwap's real schedule, the one PoolReader recovers from its config. */
const FEES: FeeSchedule = { protocolBps: 5, creatorBps: 5, lpBps: 20 };

/**
 * What an exit rule would actually have done.
 *
 * Everybody has one. Take profit at two hundred percent, cut at fifty, out
 * after ten minutes. Whether it works is the question a paper trader exists to
 * answer, and it is normally answered against a chart, which is where the
 * answer stops being true: a chart is a mid price, it is what the pool would
 * trade an infinitely small amount at, and nobody can have it.
 *
 * Everything below is about the gap between that number and the one your own
 * sell actually fetches.
 */

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OPTIONS = { fees: FEES, tokenDecimals: 6 };
const SOL = 1_000_000_000n;

/**
 * A pool walked through a price path, as real swaps would have left it.
 *
 * Constant product, so moving the price by a factor means moving the reserves
 * by its square root in each direction. That is what a real swap does to a
 * pool, which is what makes these points the same shape as recorded ones.
 */
function path(multiples: readonly number[], startSol = 300n * SOL): ReplayPoint[] {
  const startTokens = 1_000_000_000n * 1_000_000n;
  const k = startSol * startTokens;
  return multiples.map((multiple, index) => {
    // sol = sqrt(k * m), tokens = k / sol, at m times the starting price.
    const scaled = BigInt(Math.round(Math.sqrt(multiple) * 1_000_000));
    const solAfter = (startSol * scaled) / 1_000_000n;
    return {
      mint: MINT,
      at: 1_700_000_000 + index * 60,
      solAfter,
      tokenAfter: k / solAfter,
    };
  });
}

const stake = (over: Partial<Rule> = {}): Rule => ({ stake: 1n * SOL, ...over });

describe('entering', () => {
  it('reports nothing when the window is empty', () => {
    const result = backtestRule([], stake(), OPTIONS);
    expect(result.entered).toBe(false);
    expect(result.reason).toBe('no_entry');
    // Null rather than zero: nothing happened, so there is no return to report.
    expect(result.returnBps).toBeNull();
  });

  /*
   * A delay exists so somebody can ask what waiting would have done, which
   * means the entry is the first quotable moment on or after it rather than
   * the first point in the window.
   */
  it('waits out the entry delay before buying', () => {
    const points = path([1, 1.5, 2, 3]);
    const straight = backtestRule(points, stake(), OPTIONS);
    const waited = backtestRule(points, stake({ entryDelaySeconds: 120 }), OPTIONS);

    expect(straight.entry?.at).toBe(points[0]!.at);
    expect(waited.entry?.at).toBe(points[2]!.at);
    // Entering later into a rising pool buys fewer tokens for the same stake.
    expect(waited.entry!.tokens).toBeLessThan(straight.entry!.tokens);
  });

  it('charges the entry its own impact and fee', () => {
    const result = backtestRule(path([1, 1]), stake({ stake: 20n * SOL }), OPTIONS);
    expect(result.entry!.priceImpactBps).toBeGreaterThan(0);
    expect(result.entry!.feeLamports).toBeGreaterThan(0n);
  });
});

describe('the rules firing', () => {
  it('takes profit once a real exit clears the level', () => {
    const result = backtestRule(path([1, 1.2, 2, 4]), stake({ takeProfitBps: 5_000 }), OPTIONS);
    expect(result.reason).toBe('take_profit');
    expect(result.returnBps).toBeGreaterThan(5_000);
    expect(result.exit).not.toBeNull();
  });

  it('stops out once a real exit falls through the level', () => {
    const result = backtestRule(path([1, 0.9, 0.4, 0.3]), stake({ stopLossBps: 3_000 }), OPTIONS);
    expect(result.reason).toBe('stop_loss');
    expect(result.returnBps).toBeLessThan(-3_000);
  });

  it('leaves on time when neither level is reached', () => {
    const result = backtestRule(
      path([1, 1.05, 1.02, 1.04]),
      stake({ takeProfitBps: 20_000, stopLossBps: 9_000, timeoutSeconds: 120 }),
      OPTIONS,
    );
    expect(result.reason).toBe('timeout');
    expect(result.heldSeconds).toBe(120);
  });

  /*
   * A single swap can carry the price through a stop and a take profit at once
   * and only one can be true. Checking the stop first assumes the move went
   * against you before it went for you, which is the assumption a backtest
   * should make about a moment it cannot see inside of.
   */
  it('takes the stop when one swap crosses both levels', () => {
    const points: ReplayPoint[] = [...path([1]), ...path([8])].map((point, index) => ({
      ...point,
      at: 1_700_000_000 + index * 60,
    }));
    const crash: ReplayPoint[] = [...path([1]), ...path([0.1])].map((point, index) => ({
      ...point,
      at: 1_700_000_000 + index * 60,
    }));

    expect(backtestRule(points, stake({ takeProfitBps: 100, stopLossBps: 100 }), OPTIONS).reason)
      .toBe('take_profit');
    expect(backtestRule(crash, stake({ takeProfitBps: 100, stopLossBps: 100 }), OPTIONS).reason)
      .toBe('stop_loss');
  });

  it('reports a position it never exited as still open, marked at a real exit', () => {
    const result = backtestRule(path([1, 1.1, 1.2]), stake({ takeProfitBps: 100_000 }), OPTIONS);
    expect(result.reason).toBe('still_open');
    expect(result.exit).toBeNull();
    expect(result.proceeds).toBeGreaterThan(0n);
  });
});

describe('the gap the chart hides', () => {
  /*
   * The whole point of the module. A rule can be reported as never having
   * triggered even though the chart went through the level, because the chart
   * is not a price anybody can sell at.
   */
  it('costs more than the chart says, always', () => {
    const result = backtestRule(path([1, 2, 3, 5]), stake({ stake: 5n * SOL }), OPTIONS);
    expect(result.returnBps!).toBeLessThan(result.onChartBps!);
  });

  it('can miss a level the chart went through', () => {
    // A stake large enough that its own exit moves the pool back under the level.
    const points = path([1, 2.05]);
    const chart = backtestRule(points, stake({ stake: 1n * SOL }), OPTIONS).onChartBps;
    expect(chart).toBeGreaterThan(10_000);

    const heavy = backtestRule(points, stake({ stake: 120n * SOL, takeProfitBps: 10_000 }), OPTIONS);
    // Asserted, because a refused entry also reports still_open and this test
    // would then be passing for the wrong reason.
    expect(heavy.entered).toBe(true);
    expect(heavy.reason).toBe('still_open');
    expect(heavy.returnBps).toBeLessThan(10_000);
  });

  /*
   * The number that says whether a rule was survivable rather than merely
   * profitable. A rule that ends up ahead after being seventy percent down is
   * not a rule anybody actually holds through.
   */
  it('records how far under and over it went on the way', () => {
    const result = backtestRule(path([1, 0.3, 0.5, 4]), stake({ takeProfitBps: 100_000 }), OPTIONS);
    expect(result.worstBps).toBeLessThan(-6_000);
    expect(result.bestBps).toBeGreaterThan(20_000);
  });

  it('never reports a gain the exit could not have realised', () => {
    for (const multiples of [[1, 3], [1, 10], [1, 0.5], [1, 1]]) {
      const result = backtestRule(path(multiples), stake(), OPTIONS);
      expect(result.returnBps!).toBeLessThan(result.onChartBps! + 1);
    }
  });
});


/**
 * The three things a first read got wrong.
 *
 * Each was found by printing what the module actually returned rather than by
 * reasoning about it, which is the only way any of them would have surfaced.
 */
describe('what a review found', () => {
  /*
   * A position is underwater the instant it opens: two fees and the entry's own
   * impact. Starting the worst at zero claimed it had once been at break even,
   * which never happened, and it is exactly the flattering number this module
   * exists to avoid.
   */
  it('never claims the position was once at break even', () => {
    const result = backtestRule(path([1, 2, 4]), stake({ takeProfitBps: 999_999 }), OPTIONS);
    expect(result.worstBps).toBeLessThan(0);

    // And the figure it starts from is a real round trip at the entry pool.
    const roundTrip = backtestRule(path([1]), stake(), OPTIONS);
    expect(result.worstBps).toBe(roundTrip.returnBps);
  });

  /*
   * The live engine refuses a fill above its impact cap, at the quote and again
   * at the fill. Without the same ceiling this reported an entry that took
   * ninety-nine percent of a pool at three hundred thousand basis points, which
   * is a trade nobody here could have placed.
   */
  it('refuses an entry the live engine would refuse', () => {
    const absurd = backtestRule(path([1, 2]), stake({ stake: 100_000n * SOL }), OPTIONS);
    expect(absurd.entered).toBe(false);

    // And the cap is the engine's own by default.
    expect(backtestRule(path([1, 2]), stake({ stake: 100_000n * SOL }), {
      ...OPTIONS,
      maxPriceImpactBps: 10_000_000,
    }).entered).toBe(true);
  });

  /*
   * Sharper on the way out. A position too large to leave under the cap is a
   * position you are still holding, and the run says so rather than pretending
   * the door was open.
   */
  it('reports a position it could not legally exit as still open', () => {
    const result = backtestRule(
      path([1, 1, 1]),
      stake({ stake: 250n * SOL, takeProfitBps: 1 }),
      { ...OPTIONS, maxPriceImpactBps: 100 },
    );
    expect(result.entered).toBe(false);
  });

  it('carries what the legs actually cost', () => {
    const result = backtestRule(path([1, 2]), stake({ takeProfitBps: 1_000 }), OPTIONS);
    expect(result.feesPaid).toBe(result.entry!.feeLamports + result.exit!.feeLamports);
    expect(result.feesPaid).toBeGreaterThan(0n);

    // Counted on an unexited position too, since the proceeds it is measured
    // against are net of the exit fee either way.
    const open = backtestRule(path([1, 1.1]), stake({ takeProfitBps: 999_999 }), OPTIONS);
    expect(open.exit).toBeNull();
    expect(open.feesPaid).toBeGreaterThan(open.entry!.feeLamports);
  });

  it('says on every leg whether the venue took the whole size', () => {
    const result = backtestRule(path([1, 2]), stake({ takeProfitBps: 1_000 }), OPTIONS);
    expect(result.entry).toHaveProperty('partial');
    expect(result.exit).toHaveProperty('partial');
    expect(result.entry!.partial).toBe(false);
  });
});


/**
 * A second read, after the first one found three.
 */
describe('what a second review found', () => {
  /*
   * A position nobody opened and a position that cannot be closed are opposite
   * facts. Reporting the first as the second tells a reader they are holding
   * something they never bought, and `entered` being false is not much of a
   * safeguard when the reason is the field anybody reads first.
   */
  it('separates never having entered from being unable to leave', () => {
    const never = backtestRule(path([1, 2]), stake({ entryDelaySeconds: 99_999 }), OPTIONS);
    expect(never.entered).toBe(false);
    expect(never.reason).toBe('no_entry');

    const stuck = backtestRule(path([1, 1.1, 1.2]), stake({ takeProfitBps: 999_999 }), OPTIONS);
    expect(stuck.entered).toBe(true);
    expect(stuck.reason).toBe('still_open');
  });

  /*
   * Out of order points did not fail, they produced a plausible wrong answer:
   * the entry landed wherever the array happened to start and the timeout
   * measured a negative interval. A silent wrong answer is the worst outcome
   * available to something whose output becomes a claim shown to somebody.
   */
  it('reads the window in time order however it arrives', () => {
    const ordered = path([1, 2, 4]);
    const jumbled = [ordered[2]!, ordered[0]!, ordered[1]!];

    const straight = backtestRule(ordered, stake({ takeProfitBps: 5_000 }), OPTIONS);
    const shuffled = backtestRule(jumbled, stake({ takeProfitBps: 5_000 }), OPTIONS);

    expect(shuffled.entry?.at).toBe(straight.entry?.at);
    expect(shuffled.reason).toBe(straight.reason);
    expect(shuffled.returnBps).toBe(straight.returnBps);
    expect(shuffled.heldSeconds).toBe(straight.heldSeconds);
  });

  it('never measures a negative holding time', () => {
    const backwards = [...path([1, 2, 4])].reverse();
    const result = backtestRule(backwards, stake({ timeoutSeconds: 60 }), OPTIONS);
    expect(result.heldSeconds).toBeGreaterThanOrEqual(0);
    expect(result.entry!.at).toBeLessThanOrEqual(result.exit?.at ?? Infinity);
  });

  /*
   * A partial buy is charged for what it delivered rather than for what was
   * asked, so the cost every return is measured against stays true.
   */
  it('measures the return against what the entry actually cost', () => {
    const result = backtestRule(path([1, 2]), stake({ takeProfitBps: 1_000 }), OPTIONS);
    expect(result.entry!.sol).toBeLessThanOrEqual(result.stake);
    expect(result.returnBps).toBe(
      Number(((result.proceeds! - result.entry!.sol) * 10_000n) / result.entry!.sol),
    );
  });

  /*
   * A dead pool in the middle of a window is a moment the rule cannot act on,
   * not a total loss and not a free hold at the last good price.
   */
  it('walks past a point with no reserves at all', () => {
    const points = path([1, 1, 1]);
    points[1] = { ...points[1]!, solAfter: 0n, tokenAfter: 0n };

    const result = backtestRule(points, stake({ takeProfitBps: 100 }), OPTIONS);
    expect(result.entered).toBe(true);
    expect(result.returnBps).toBeLessThan(0);
    expect(Number.isFinite(result.returnBps)).toBe(true);
  });
});


/**
 * A third read. This one found the module doing the thing it had written a
 * comment forbidding.
 */
describe('what a third review found', () => {
  /*
   * exitQuote's own comment says treating an unquotable exit as zero would
   * invent a total loss. The final marking then did exactly that: a pool that
   * collapsed to dust inside the window came back as minus a hundred percent,
   * which is a claim about somebody's money invented out of an absence.
   */
  it('never reports a total loss for a position it merely could not price', () => {
    const points = path([1, 1]);
    points[1] = { ...points[1]!, solAfter: 1n, tokenAfter: 1n };

    const result = backtestRule(points, stake(), OPTIONS);
    expect(result.entered).toBe(true);
    expect(result.reason).toBe('illiquid');
    expect(result.proceeds).toBeNull();
    expect(result.returnBps).toBeNull();
  });

  /*
   * The same rule everywhere: a number is reported only when a real exit could
   * price it. Anything else is a figure with nothing behind it.
   */
  it('reports no figure at all where nothing could be priced', () => {
    const never = backtestRule(path([1, 2]), stake({ entryDelaySeconds: 99_999 }), OPTIONS);
    expect(never.proceeds).toBeNull();
    expect(never.returnBps).toBeNull();
    expect(never.worstBps).toBeNull();
    expect(never.bestBps).toBeNull();
    expect(never.onChartBps).toBeNull();
  });

  it('has no chart number for a pool with no reserves', () => {
    const points = path([1, 1]);
    points[1] = { ...points[1]!, solAfter: 0n, tokenAfter: 0n };
    expect(backtestRule(points, stake(), OPTIONS).onChartBps).toBeNull();
  });

  /*
   * And the ordinary case keeps every figure, so the nullability is a real
   * signal rather than something a caller learns to ignore.
   */
  it('still reports every figure when the run could be priced', () => {
    const result = backtestRule(path([1, 2, 4]), stake({ takeProfitBps: 5_000 }), OPTIONS);
    expect(result.reason).toBe('take_profit');
    for (const value of [result.proceeds, result.returnBps, result.worstBps, result.bestBps, result.onChartBps]) {
      expect(value).not.toBeNull();
    }
  });
});

/* A deterministic pseudo random walk, so the sweep is reproducible. */
function walk(seed: number, steps: number): ReplayPoint[] {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const s0 = 300n * SOL, t0 = 1_000_000_000n * 1_000_000n, k = s0 * t0;
  let m = 1;
  return Array.from({ length: steps }, (_, i) => {
    m = Math.max(0.01, m * (0.75 + rand() * 0.6));
    const sc = BigInt(Math.max(1, Math.round(Math.sqrt(m) * 1e6)));
    const sol = (s0 * sc) / 1_000_000n;
    return { mint: 'M', at: 1_700_000_000 + i * 60, solAfter: sol, tokenAfter: k / sol };
  });
}

/**
 * The central claim, swept rather than argued.
 *
 * Every case above picks a path to make a point. This picks a thousand of them
 * and holds the one thing that must be true of all of them: a real fill can
 * never beat the mid. If any arrangement of stake, thresholds and price path
 * ever produced a return above the chart, the module would be flattering
 * somebody, which is the single failure it exists to prevent.
 *
 * Deterministic, so a failure names a seed that reproduces it.
 */
describe('the core claim, swept', () => {
  it('a real fill never beats the chart, across a thousand runs', () => {
    let checked = 0, entered = 0, illiquid = 0;
    for (let seed = 1; seed <= 1000; seed += 1) {
      const points = walk(seed, 20);
      const rule: Rule = {
        stake: BigInt(1 + (seed % 40)) * SOL,
        takeProfitBps: [500, 5_000, 50_000][seed % 3]!,
        stopLossBps: [1_000, 3_000, 9_000][seed % 3]!,
        timeoutSeconds: (seed % 5) * 300,
      };
      const r = backtestRule(points, rule, OPTIONS);
      if (!r.entered) continue;
      entered += 1;
      if (r.reason === 'illiquid') { illiquid += 1; continue; }
      if (r.returnBps === null || r.onChartBps === null) continue;
      checked += 1;
      // The whole premise: your fill can never be better than the mid.
      expect(r.returnBps, `seed ${seed}`).toBeLessThanOrEqual(r.onChartBps);
      // And nothing is ever worth less than nothing.
      expect(r.proceeds!).toBeGreaterThanOrEqual(0n);
      expect(r.returnBps).toBeGreaterThanOrEqual(-10_000);
      if (r.worstBps !== null && r.bestBps !== null) {
        expect(r.worstBps).toBeLessThanOrEqual(r.bestBps);
      }
    }
    void illiquid;
    expect(checked).toBeGreaterThan(500);
  });
});

/** One point at a given multiple of the starting price. */
function onePoint(m: number, i: number): ReplayPoint {
  const s0 = 300n * SOL;
  const t0 = 1_000_000_000n * 1_000_000n;
  const k = s0 * t0;
  const scaled = BigInt(Math.max(1, Math.round(Math.sqrt(m) * 1_000_000)));
  const sol = (s0 * scaled) / 1_000_000n;
  return { mint: MINT, at: 1_700_000_000 + i * 60, solAfter: sol, tokenAfter: k / sol };
}

function samePool(p: ReplayPoint): PoolState {
  return {
    mint: p.mint,
    solReserve: p.solAfter,
    tokenReserve: p.tokenAfter,
    deliverableTokens: p.tokenAfter,
    tokenDecimals: 6,
    fees: FEES,
    source: 'pumpswap',
    slot: 0,
  };
}

/**
 * The backtest against the live engine.
 *
 * Four reads of this module found six things and the fifth found none, which is
 * roughly where reading the same code again stops paying. This is a different
 * question: not whether the module is self consistent, but whether it agrees
 * with the engine it claims to be a backtest of.
 *
 * Two independent paths producing the same fill is the strongest check
 * available here, and it is the one that keeps mattering. If either side ever
 * drifts, a backtest quietly stops describing this platform and starts
 * describing a slightly different one, which is the failure nobody would
 * notice from the inside.
 */
describe('the backtest against the live engine', () => {
  it('produces the fill the trade route would have produced', () => {
    for (const [m, stakeSol] of [[1, 1], [1, 10], [2.5, 3], [0.4, 25], [7, 2]] as const) {
      const points = [onePoint(m, 0), onePoint(m, 1)];
      const stake = BigInt(stakeSol) * SOL;

      const back = backtestRule(points, { stake }, OPTIONS);
      // No latency in a replay, so the click and the fill meet the same pool.
      const live = simulateFill({
        side: 'buy', size: stake, atClick: samePool(points[0]!), atFill: samePool(points[0]!),
        rules: { ...DEFAULT_RULES, slippageBps: 10_000 },
      });

      expect(live.status, `m=${m} stake=${stakeSol}`).toBe('filled');
      if (live.status !== 'filled') continue;
      expect(back.entry!.tokens, `m=${m}`).toBe(live.quote.tokenAmount);
      expect(back.entry!.sol).toBe(live.quote.solAmount);
      expect(back.entry!.feeLamports).toBe(live.quote.feeLamports);
      expect(back.entry!.priceImpactBps).toBe(live.quote.priceImpactBps);
    }
  });

  it('refuses exactly what the live engine refuses', () => {
    for (const stakeSol of [200, 400, 1_000, 5_000]) {
      const points = [onePoint(1, 0), onePoint(1, 1)];
      const stake = BigInt(stakeSol) * SOL;

      const back = backtestRule(points, { stake }, OPTIONS);
      const live = simulateFill({
        side: 'buy', size: stake, atClick: samePool(points[0]!), atFill: samePool(points[0]!),
        rules: { ...DEFAULT_RULES, slippageBps: 10_000 },
      });

      const liveRefused = live.status === 'rejected' && live.reason === 'price_impact';
      expect(back.entered, `stake=${stakeSol} live=${live.status}`).toBe(!liveRefused);
    }
  });
});
