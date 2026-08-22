import { describe, expect, it, vi } from 'vitest';

/**
 * The two figures that say what a result is worth.
 *
 * These points are what the site has walked rather than every swap a token ever
 * had, so they can be hours apart, and a rule is only ever checked at a point.
 * A stop set at fifty percent whose first recorded swap past the level was
 * already at ninety-six is not a fifty percent stop, and the exit figure alone
 * reads exactly as though it were.
 *
 * Found on live data: Fartcoin, 293 recorded swaps over 52 days, one every four
 * and a bit hours, a 50% stop reported at -96.50%.
 */

const MINT = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
let timeline: { swaps: unknown[]; truncated: boolean } = { swaps: [], truncated: false };

vi.mock('../db', () => ({ db: async () => ({}) }));
vi.mock('../rpc', () => ({ resolveMint: async () => ({ pool: null }) }));
vi.mock('@probatio/db', () => ({ tokenTimeline: async () => timeline }));

const SOL = 1_000_000_000n;

/** A pool walked through a price path, at whatever spacing is asked for. */
function walked(multiples: readonly number[], gapSeconds: number) {
  const s0 = 300n * SOL;
  const k = s0 * (1_000_000_000n * 1_000_000n);
  return {
    truncated: false,
    swaps: multiples.map((multiple, index) => {
      const scaled = BigInt(Math.max(1, Math.round(Math.sqrt(multiple) * 1_000_000)));
      const sol = (s0 * scaled) / 1_000_000n;
      return {
        trader: 'T',
        mint: MINT,
        isBuy: true,
        solAmount: '1',
        tokenAmount: '1',
        solAfter: sol.toString(),
        tokenAfter: (k / sol).toString(),
        blockTime: 1_700_000_000 + index * gapSeconds,
      };
    }),
  };
}

describe('how fine an answer is', () => {
  it('reports the typical gap between recorded swaps', async () => {
    timeline = walked(Array.from({ length: 60 }, () => 1), 15_400);
    const { runBacktest } = await import('../backtest');

    const report = await runBacktest(MINT, { stake: SOL });
    expect('medianGapSeconds' in report && report.medianGapSeconds).toBe(15_400);
  });

  /*
   * The one the live data surfaced. A stop fires on the first recorded point
   * below the level, and on a sparse record that point can be a long way below
   * it. Reporting the exit without this reads as though the rule had worked.
   */
  it('says how far past its level a rule actually got out', async () => {
    // Flat, then straight off a cliff with nothing recorded in between.
    timeline = walked([...Array.from({ length: 50 }, () => 1), 0.02], 15_400);
    const { runBacktest } = await import('../backtest');

    const report = await runBacktest(MINT, { stake: SOL, stopLossBps: 5_000 });
    if (!('result' in report)) throw new Error('expected a result');

    expect(report.result.reason).toBe('stop_loss');
    expect(report.result.returnBps!).toBeLessThan(-9_000);
    // Set at 50%, got out at 96 and change: the difference is the sampling.
    expect(report.overshootBps!).toBeGreaterThan(4_000);
  });

  it('has no overshoot to report when no level was crossed', async () => {
    timeline = walked(Array.from({ length: 60 }, () => 1), 60);
    const { runBacktest } = await import('../backtest');

    const report = await runBacktest(MINT, { stake: SOL, timeoutSeconds: 600 });
    if (!('result' in report)) throw new Error('expected a result');

    expect(report.result.reason).toBe('timeout');
    expect(report.overshootBps).toBeNull();
  });

  /*
   * The one this test used to get backwards.
   *
   * It was called "is not fooled by a burst followed by a long quiet" and then
   * asserted the median was ten seconds, which is precisely being fooled. A
   * median measures the inside of a burst, so on real data it reports dense
   * coverage for a record with days missing from it: Fartcoin, 311 points over
   * 53 days, median gap eighteen seconds.
   *
   * The largest gap is the figure that cannot be faked by clustering, so that
   * is what the panel leads with now.
   */
  it('is not fooled by a burst followed by a long quiet', async () => {
    const swaps = walked(Array.from({ length: 50 }, () => 1), 10).swaps as { blockTime: number }[];
    swaps[swaps.length - 1]!.blockTime = swaps[0]!.blockTime + 400_000;
    timeline = { swaps, truncated: false };

    const { runBacktest } = await import('../backtest');
    const report = await runBacktest(MINT, { stake: SOL });
    if (!('result' in report)) throw new Error('expected a result');

    // The burst is real and still reported, but it is no longer the whole story.
    expect(report.medianGapSeconds).toBe(10);
    // 49 points ten seconds apart, then one point four hundred thousand later.
    expect(report.worstGapSeconds).toBe(400_000 - 48 * 10);
  });

  /*
   * The hole the rule jumped, which is the number that explains the overshoot.
   * A stop set at fifty that filled at ninety-six was not checked in between,
   * and this says for how long.
   */
  it('says how long nothing was recorded before the exit fired', async () => {
    const swaps = walked([...Array.from({ length: 50 }, () => 1), 0.02], 10).swaps as {
      blockTime: number;
    }[];
    // The cliff is not ten seconds after the last flat point, it is a day after.
    swaps[swaps.length - 1]!.blockTime = swaps[swaps.length - 2]!.blockTime + 86_400;
    timeline = { swaps, truncated: false };

    const { runBacktest } = await import('../backtest');
    const report = await runBacktest(MINT, { stake: SOL, stopLossBps: 5_000 });
    if (!('result' in report)) throw new Error('expected a result');

    expect(report.result.reason).toBe('stop_loss');
    expect(report.exitGapSeconds).toBe(86_400);
  });

  /*
   * Several swaps can share a block time, so stepping back one index can land on
   * a point at the same second and report a gap of zero for a rule that had not
   * been checked for a day. Measured against the last point strictly before it.
   */
  it('measures the exit gap past swaps sharing a block time', async () => {
    const swaps = walked([...Array.from({ length: 50 }, () => 1), 0.02, 0.02], 10).swaps as {
      blockTime: number;
    }[];
    const cliff = swaps[swaps.length - 3]!.blockTime + 86_400;
    swaps[swaps.length - 2]!.blockTime = cliff;
    swaps[swaps.length - 1]!.blockTime = cliff;
    timeline = { swaps, truncated: false };

    const { runBacktest } = await import('../backtest');
    const report = await runBacktest(MINT, { stake: SOL, stopLossBps: 5_000 });
    if (!('result' in report)) throw new Error('expected a result');

    expect(report.exitGapSeconds).toBe(86_400);
  });

  /*
   * The claim the panel used to make about every result: that the whole record
   * was the test. A run that stops out at the second point was checked at two
   * swaps, and saying three hundred credits it with coverage it never had.
   */
  it('counts the swaps the rule was checked at, not the size of the record', async () => {
    // Flat for one point, off a cliff at the second, then three hundred more
    // points that the position was already closed for.
    const swaps = walked(
      [1, 0.02, ...Array.from({ length: 300 }, () => 0.02)],
      10,
    ).swaps as { blockTime: number }[];
    swaps[1]!.blockTime = swaps[0]!.blockTime + 86_400;
    for (let index = 2; index < swaps.length; index += 1) {
      swaps[index]!.blockTime = swaps[1]!.blockTime + (index - 1) * 10;
    }
    timeline = { swaps, truncated: false };

    const { runBacktest } = await import('../backtest');
    const report = await runBacktest(MINT, { stake: SOL, stopLossBps: 5_000 });
    if (!('result' in report)) throw new Error('expected a result');

    expect(report.result.reason).toBe('stop_loss');
    expect(report.points).toBe(302);
    // Entry at the first, exit at the second. The other three hundred are not
    // part of this answer.
    expect(report.checkedPoints).toBe(2);
    /*
     * And the spacing describes those two, not the record. The three hundred
     * dense points sit after the position closed, so a ten second median would
     * be describing a stretch where nothing was open.
     */
    expect(report.worstGapSeconds).toBe(86_400);
  });

  /*
   * A position still open was never sold, so there is no hole to have jumped.
   * Reporting one would attach a gap to a sale that did not happen.
   */
  it('has no exit gap to report when nothing was sold', async () => {
    timeline = walked(Array.from({ length: 60 }, () => 1), 60);
    const { runBacktest } = await import('../backtest');

    const report = await runBacktest(MINT, { stake: SOL, takeProfitBps: 1_000_000 });
    if (!('result' in report)) throw new Error('expected a result');

    expect(report.result.reason).toBe('still_open');
    expect(report.result.exit).toBeNull();
    expect(report.exitGapSeconds).toBeNull();
  });
});
