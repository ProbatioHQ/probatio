import { describe, expect, it } from 'vitest';
import { backtestCopy, type CopyInput } from '../src/copy';
import type { FeeSchedule } from '../src/types';

// The pumpswap schedule, matching packages/pools/src/fees.ts.
const PUMPSWAP_FEES: FeeSchedule = { protocolBps: 95, creatorBps: 30, lpBps: 0 };

const MINT = 'Mint1111111111111111111111111111111111111111';
const SOL = 1_000_000_000n;

/*
 * Swap amounts here have to agree with the pool the swap reports.
 *
 * The backtest drops any leg whose own price is orders of magnitude from the
 * reserves it left behind, because that is not a trade against that pool and
 * pricing it produced figures like six million SOL realized on a ten SOL
 * account. Three fixtures below were written before that check existed and were
 * quietly incoherent: a five hundred SOL buy against a hundred SOL pool. They
 * are consistent now, and they still test the same things.
 *
 * The default pool is 100 SOL against 1e12 tokens, so a coherent swap moves
 * 1e10 tokens per SOL.
 */

/**
 * A copy backtest is only worth anything if it refuses to flatter itself.
 *
 * These are the properties that make the number honest rather than marketing:
 * the copier never gets the leader's price, sells are proportional, and a
 * leader who made money can still leave a copier behind.
 */

let clock = 1_800_000_000;

function swap(over: Partial<CopyInput> & Pick<CopyInput, 'isBuy' | 'solAmount' | 'tokenAmount'>): CopyInput {
  clock += 60;
  return {
    trader: 'leader',
    mint: MINT,
    solAfter: (100n * SOL).toString(),
    tokenAfter: (1_000_000_000_000n).toString(),
    blockTime: clock,
    ...over,
  };
}

const options = { startingBalance: 10n * SOL, fees: PUMPSWAP_FEES };

describe('backtesting a copy', () => {
  it('does nothing with no swaps', () => {
    const result = backtestCopy([], options);
    expect(result.copied).toBe(0);
    expect(result.endingEquity).toBe(options.startingBalance);
    expect(result.returnBps).toBe(0);
  });

  /*
   * The whole point. The copier fills into the pool the leader's own order left
   * behind, so they pay more per token. A backtest where this is not true is
   * the lie every copy trading product tells.
   */
  it('never gives the copier the leader price on a buy', () => {
    const result = backtestCopy(
      [swap({ isBuy: true, solAmount: (5n * SOL).toString(), tokenAmount: '50000000000' })],
      options,
    );

    const [leg] = result.legs;
    expect(leg).toBeDefined();
    expect(leg!.copierPrice).toBeGreaterThan(leg!.leaderPrice);
    expect(result.latencyCost).toBeGreaterThan(0n);
  });

  it('commits a fraction of the balance, not the leader size', () => {
    const small = backtestCopy(
      [swap({ isBuy: true, solAmount: (500n * SOL).toString(), tokenAmount: '5000000000000' })],
      { ...options, startingBalance: 2n * SOL, maxPositionBps: 3_000 },
    );

    // Thirty percent of two SOL, never the leader's five hundred.
    expect(small.legs[0]?.sol).toBe((2n * SOL * 3_000n) / 10_000n);
    expect(small.endingBalance).toBeLessThan(2n * SOL);
  });

  it('sells the same fraction of the position the leader sold', () => {
    const result = backtestCopy(
      [
        swap({ isBuy: true, solAmount: SOL.toString(), tokenAmount: '10000000000' }),
        // Half of what they bought.
        swap({ isBuy: false, solAmount: (SOL / 2n).toString(), tokenAmount: '5000000000' }),
      ],
      options,
    );

    const buy = result.legs.find((leg) => leg.isBuy);
    const sell = result.legs.find((leg) => !leg.isBuy);
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    // Half the tokens the copier holds, not half the leader's token count.
    expect(sell!.tokens).toBe(buy!.tokens / 2n);
  });

  it('treats a sell larger than the tracked position as a full exit', () => {
    const result = backtestCopy(
      [
        swap({ isBuy: true, solAmount: SOL.toString(), tokenAmount: '10000000000' }),
        swap({ isBuy: false, solAmount: (3n * SOL).toString(), tokenAmount: '29999999999' }),
      ],
      options,
    );

    const buy = result.legs.find((leg) => leg.isBuy);
    const sell = result.legs.find((leg) => !leg.isBuy);
    expect(sell!.tokens).toBe(buy!.tokens);
  });

  it('ignores a sell of something never bought', () => {
    const result = backtestCopy(
      [swap({ isBuy: false, solAmount: SOL.toString(), tokenAmount: '1000000' })],
      options,
    );

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.endingEquity).toBe(options.startingBalance);
  });

  /*
   * The number this feature exists to produce. A leader who doubles their money
   * does not hand the copier the same result, because the copier bought after
   * them and sold after them, both times at a worse price.
   */
  it('leaves the copier behind a leader who made money', () => {
    const result = backtestCopy(
      [
        swap({
          isBuy: true,
          solAmount: (2n * SOL).toString(),
          tokenAmount: '20000000000',
          solAfter: (100n * SOL).toString(),
          tokenAfter: '1000000000000',
        }),
        swap({
          isBuy: false,
          solAmount: (4n * SOL).toString(),
          tokenAmount: '20000000000',
          solAfter: (140n * SOL).toString(),
          tokenAfter: '900000000000',
        }),
      ],
      options,
    );

    expect(result.leaderReturnBps).toBe(10_000);
    expect(result.returnBps).toBeLessThan(result.leaderReturnBps);
    expect(result.latencyCost).toBeGreaterThan(0n);
  });

  /*
   * The bug this exists to stop, found live on a real wallet.
   *
   * The leader's return counted every SOL they had put in against only what had
   * come back out, while the copier was credited with what it still held. A
   * wallet that scaled out and kept a tail, which is most of them, was reported
   * down ninety-five per cent while a copier following its every trade was up
   * twelve, on the same trades. The entire claim of this panel is that the
   * copier does worse, so a bug that flatters the copier is the worst one
   * available.
   *
   * Both sides are realized money over the cost it was made on now, which is
   * also what the board above this panel reports, so a row and its panel can no
   * longer contradict each other in public.
   */
  it('scores an accumulating leader on what it sold, not on what it still holds', () => {
    const accumulating = backtestCopy(
      [
        swap({ isBuy: true, solAmount: (2n * SOL).toString(), tokenAmount: '20000000000' }),
        swap({
          isBuy: false,
          solAmount: (SOL / 2n).toString(),
          tokenAmount: '5000000000',
          solAfter: (99n * SOL).toString(),
          tokenAfter: '1005000000000',
        }),
      ],
      options,
    );

    // They put in two SOL, took half a SOL back out, and are still holding
    // three quarters of the position. Counting only what came back would call
    // that a seventy-five per cent loss.
    expect(accumulating.leaderReturnBps).toBeGreaterThan(-2_500);
    expect(accumulating.returnBps).toBeLessThan(accumulating.leaderReturnBps);
  });

  it('marks what is still held rather than counting it as zero', () => {
    const open = backtestCopy(
      [swap({ isBuy: true, solAmount: SOL.toString(), tokenAmount: '10000000000' })],
      options,
    );

    // Some of the balance was spent, so equity above balance means the position
    // is being carried at something rather than written off.
    expect(open.endingBalance).toBeLessThan(options.startingBalance);
    expect(open.endingEquity).toBeGreaterThan(open.endingBalance);
  });

  it('skips a swap with no reserves to price against', () => {
    const result = backtestCopy(
      [swap({ isBuy: true, solAmount: '0', tokenAmount: '0' })],
      options,
    );

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

/**
 * The property the whole panel rests on.
 *
 * It was violated live, on a real wallet, and the arithmetic was not even
 * wrong: the leader was scored as a flat ratio of everything realized over
 * everything it cost, while the copier compounded a ten SOL balance. A copier
 * that equal-weights every entry genuinely can beat a trader whose losses were
 * their big bets, and a compounding balance genuinely does outrun a ratio of
 * sums. Both numbers were right and the sentence between them was false. It
 * printed the leader up thirty-six per cent and the copier up seventy-seven.
 */
describe('the copier can never come out ahead on execution alone', () => {
  it('holds across a hundred varied trades', () => {
    const swaps: CopyInput[] = [];
    let sol = 400n * SOL;
    let tokens = 2_000_000_000_000n;

    for (let i = 0; i < 100; i += 1) {
      // Deterministic but uneven: sizes swing, and the direction turns often
      // enough that both sides hold and exit repeatedly.
      const step = BigInt(((i * 37) % 23) + 1);
      const buy = i % 3 !== 2;
      const solAmount = (SOL * step) / 4n;
      const tokenAmount = (solAmount * tokens) / sol;
      if (tokenAmount <= 0n) continue;

      sol = buy ? sol + solAmount : sol - solAmount;
      tokens = buy ? tokens - tokenAmount : tokens + tokenAmount;

      swaps.push(
        swap({
          isBuy: buy,
          solAmount: solAmount.toString(),
          tokenAmount: tokenAmount.toString(),
          solAfter: sol.toString(),
          tokenAfter: tokens.toString(),
        }),
      );
    }

    const result = backtestCopy(swaps, options);

    expect(result.copied).toBeGreaterThan(20);
    // Same strategy, same balance, same fractions. Only the prices differ, so
    // the copier is behind or level, never in front.
    expect(result.returnBps).toBeLessThanOrEqual(result.leaderReturnBps);
    expect(BigInt(result.copierRealized)).toBeLessThanOrEqual(BigInt(result.leaderRealized));
  });
});

/**
 * A comparison that stays a comparison.
 *
 * Sizing each entry off the running balance compounds, and two portfolios that
 * differ by a few basis points a trade do not finish slightly apart over two
 * hundred entries: they finish orders of magnitude apart. On a real wallet the
 * leader's side printed 3.02e+24 SOL, which is not a number, and on another the
 * copier came out ahead because the compounding cut the other way that time.
 */
describe('a long window does not explode', () => {
  it('keeps both sides on the same scale through a strong trend', () => {
    const swaps: CopyInput[] = [];
    let sol = 500n * SOL;
    let tokens = 5_000_000_000_000n;

    // Two hundred trades that make money nearly every time, which is exactly
    // the shape that ran away before.
    for (let i = 0; i < 200; i += 1) {
      const buy = i % 4 !== 3;
      const solAmount = SOL;
      const tokenAmount = (solAmount * tokens) / sol;
      sol = buy ? sol + solAmount : sol - solAmount;
      tokens = buy ? tokens - tokenAmount : tokens + tokenAmount;
      swaps.push(
        swap({
          isBuy: buy,
          solAmount: solAmount.toString(),
          tokenAmount: tokenAmount.toString(),
          solAfter: sol.toString(),
          tokenAfter: tokens.toString(),
        }),
      );
    }

    const result = backtestCopy(swaps, options);

    // Both sides are still measured in SOL somebody could actually have.
    const ceiling = options.startingBalance * 1_000n;
    expect(BigInt(result.leaderRealized) < ceiling).toBe(true);
    expect(BigInt(result.copierRealized) < ceiling).toBe(true);
    expect(result.returnBps).toBeLessThanOrEqual(result.leaderReturnBps);
  });
});

/**
 * The guard that stops a bad row of data becoming a headline.
 *
 * The parser reads whatever the chain hands it, and not everything that looks
 * like a swap is one. A single recorded leg with a near-zero SOL amount against
 * a real token count implies a price thousands of times off, and one entry at
 * that price sold later at a normal one produced 6,877,920 SOL realized on a
 * ten SOL account, and a headline of eleven million per cent.
 */
describe('a leg that disagrees with its own pool', () => {
  it('is dropped rather than priced', () => {
    const result = backtestCopy(
      [
        // A hundred SOL pool against a trillion tokens is 1e10 tokens per SOL.
        // This claims a thousand times that, for one lamport.
        swap({ isBuy: true, solAmount: '1', tokenAmount: '10000000000000' }),
        swap({ isBuy: true, solAmount: SOL.toString(), tokenAmount: '10000000000' }),
      ],
      options,
    );

    expect(result.skipped).toBe(1);
    expect(result.copied).toBe(1);
    // Nothing on either side is a figure nobody could hold.
    expect(BigInt(result.leaderRealized) < options.startingBalance * 100n).toBe(true);
  });
});

/**
 * The shape that kept breaking it.
 *
 * Every earlier version ran two portfolios that merely followed the same rules,
 * and filled at different prices they end up holding different token counts, so
 * the same fraction sells different economic amounts, so the balances diverge,
 * so they start skipping different legs. Three fixes each closed one route and
 * left the others open, and on live data the copier came out ahead on three of
 * five wallets.
 *
 * There is one position now, held by both, and the only difference is what each
 * pays for those exact tokens and receives for them. That is checked here
 * against the case that used to defeat it: several mints, uneven sizes, partial
 * exits, and a sell of something the window never saw bought.
 */
describe('many mints, uneven sizes, and no way for the copier to win', () => {
  it('keeps the leader ahead on both the total and the rate', () => {
    const pools = new Map<string, { sol: bigint; tokens: bigint }>();
    const swaps: CopyInput[] = [];

    const leg = (mint: string, isBuy: boolean, size: bigint): CopyInput => {
      const pool = pools.get(mint) ?? { sol: 300n * SOL, tokens: 3_000_000_000_000n };
      const tokens = (size * pool.tokens) / pool.sol;
      pools.set(
        mint,
        isBuy
          ? { sol: pool.sol + size, tokens: pool.tokens - tokens }
          : { sol: pool.sol - size, tokens: pool.tokens + tokens },
      );
      const after = pools.get(mint)!;
      return swap({
        mint,
        isBuy,
        solAmount: size.toString(),
        tokenAmount: tokens.toString(),
        solAfter: after.sol.toString(),
        tokenAfter: after.tokens.toString(),
      });
    };

    for (let round = 0; round < 40; round += 1) {
      for (const mint of ['A', 'B', 'C', 'D']) {
        const n = (round * 7 + mint.charCodeAt(0)) % 10;
        swaps.push(
          n < 5 ? leg(mint, true, (SOL * BigInt(n + 1)) / 2n) : leg(mint, false, (SOL * BigInt(n - 3)) / 3n),
        );
      }
    }
    // Selling something never bought in the window, which used to let the two
    // sides drift apart from each other.
    swaps.push(leg('E', false, SOL));

    const result = backtestCopy(swaps, options);

    expect(result.copied).toBeGreaterThan(50);
    expect(BigInt(result.leaderRealized) >= BigInt(result.copierRealized)).toBe(true);
    expect(result.leaderReturnBps).toBeGreaterThanOrEqual(result.returnBps);
  });
});

/**
 * No leg where the copier gets the better price.
 *
 * This is the one that live data broke, on a build where the invariant was
 * supposedly structural. A recorded swap's SOL amount is not purely what
 * reached the pool: priority fees, tips, and multi-hop routing all land in it,
 * so the leader's apparent price can look worse than the pool's own. On a real
 * wallet the copier came out ahead on six legs of twelve, including a buy at
 * 129.3m against their 149.3m, which cannot happen to somebody arriving second.
 *
 * The pool bounds it. They traded against it before it moved, so on a buy their
 * price cannot be above where it ended and on a sell it cannot be below.
 */
describe('the leader never gets a worse price than the pool they left', () => {
  it('holds on every leg, even when the recorded amount says otherwise', () => {
    const result = backtestCopy(
      [
        // A buy that claims to have paid far over the pool's price, which is
        // what a transaction full of tips looks like from outside.
        swap({
          isBuy: true,
          solAmount: (5n * SOL).toString(),
          tokenAmount: '10000000000',
          solAfter: (100n * SOL).toString(),
          tokenAfter: '1000000000000',
        }),
        swap({
          isBuy: false,
          solAmount: '1',
          tokenAmount: '10000000000',
          solAfter: (100n * SOL).toString(),
          tokenAfter: '1000000000000',
        }),
      ],
      options,
    );

    for (const leg of result.legs) {
      const better = leg.isBuy
        ? BigInt(leg.copierPrice) < BigInt(leg.leaderPrice)
        : BigInt(leg.copierPrice) > BigInt(leg.leaderPrice);
      expect(better).toBe(false);
    }
    expect(BigInt(result.leaderRealized) >= BigInt(result.copierRealized)).toBe(true);
  });
});
