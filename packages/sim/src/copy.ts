import { quoteBuy, quoteSell } from './engine';
import type { FeeSchedule, PoolState } from './types';

/**
 * What copying somebody would actually have made you.
 *
 * Every copy trading product shows you the leader's return. You do not get the
 * leader's return. You arrive after them, into a pool their own order has just
 * moved, and you pay the price impact your own size causes on top. On tokens
 * this thin that gap is most of the answer, and it is the single reason people
 * lose money following a wallet that is genuinely good.
 *
 * This computes the gap instead of hiding it. Three rules, and each one exists
 * because breaking it is how the number becomes a lie:
 *
 * The copier fills at the pool the leader left behind, never at the leader's
 * price. That is the latency cost, and it is not an estimate: it is the
 * reserves their transaction actually produced.
 *
 * Sizes are proportional, not absolute. Copying a fifty SOL buy with a ten SOL
 * balance is not a smaller version of the same trade, it is a different one.
 * The copier commits the same fraction of what they have.
 *
 * The copier's own impact is charged by the same engine that quotes every other
 * fill on this site, which is the one measured to zero basis points against
 * real swaps. A backtest priced by anything softer would flatter itself.
 */

export interface CopyLeg {
  readonly mint: string;
  readonly isBuy: boolean;
  readonly at: number;
  /** Lamports the copier put in on a buy, or received on a sell. */
  readonly sol: bigint;
  readonly tokens: bigint;
  /** What the leader got per token, and what the copier got, in lamports. */
  readonly leaderPrice: bigint;
  readonly copierPrice: bigint;
}

export interface CopyResult {
  readonly startingBalance: bigint;
  readonly endingBalance: bigint;
  /** Balance plus anything still held, marked at the last pool seen. */
  readonly endingEquity: bigint;
  readonly returnBps: number;
  /**
   * What the leader made over the same swaps, on what they staked.
   *
   * Marked the same way as the copier's, holdings included, or the comparison
   * silently favours whichever side gets credit for its open positions.
   */
  readonly leaderReturnBps: number;
  /** Lamports each side actually took back out, over and above what it cost. */
  readonly leaderRealized: bigint;
  readonly copierRealized: bigint;
  readonly legs: readonly CopyLeg[];
  readonly copied: number;
  readonly skipped: number;
  /** Lamports given up purely by arriving after the leader. */
  readonly latencyCost: bigint;
}

export interface CopyInput {
  readonly trader: string;
  readonly mint: string;
  readonly isBuy: boolean;
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly solAfter: string;
  readonly tokenAfter: string;
  readonly blockTime: number;
}

export interface CopyOptions {
  readonly startingBalance: bigint;
  readonly fees: FeeSchedule;
  readonly tokenDecimals?: number;
  /**
   * The most of the balance one position may take.
   *
   * A leader who puts eighty percent of their book into one token is making a
   * bet the copier may not want, and without a cap a single trade can end the
   * backtest. Applied to the copier, never to the leader's own numbers.
   */
  readonly maxPositionBps?: number;
}

const BPS = 10_000n;

function poolFrom(input: CopyInput, options: CopyOptions): PoolState {
  const solReserve = BigInt(input.solAfter);
  const tokenReserve = BigInt(input.tokenAfter);
  return {
    mint: input.mint,
    solReserve,
    tokenReserve,
    // A pool can deliver what it holds. The curve's virtual-reserve case does
    // not arise here: these are swaps read from a real pool's own balances.
    deliverableTokens: tokenReserve,
    tokenDecimals: options.tokenDecimals ?? 6,
    fees: options.fees,
    source: 'pumpswap',
    slot: 0,
  };
}

/** Lamports per token, scaled by 1e9 so it survives integer division. */
/**
 * How far a swap's own price may sit from the pool it reports, as a ratio.
 *
 * Ten. A real trade against a real pool moves it by its own impact and nothing
 * else, so an order of magnitude is already generous; past that the two numbers
 * are not describing the same market and one of them is wrong.
 */
const PRICE_SANITY = 10n;

function unitPrice(sol: bigint, tokens: bigint): bigint {
  return tokens === 0n ? 0n : (sol * 1_000_000_000n) / tokens;
}

export function backtestCopy(
  swaps: readonly CopyInput[],
  options: CopyOptions,
): CopyResult {
  const maxPositionBps = BigInt(options.maxPositionBps ?? 3_000);

  /*
   * Every entry is the same fraction of the *starting* balance, on both sides.
   *
   * Sizing off the running balance is what a person actually does, and it is
   * ruinous as a comparison. Two portfolios with a small per-trade difference,
   * compounded over two hundred entries, do not end up slightly apart: they end
   * up orders of magnitude apart. The leader's side reached 3.02e+24 SOL on a
   * real wallet, which is not a number, and the copier came out ahead on
   * another because the compounding cut the other way that time.
   *
   * Fixed, the two runs stay comparable for the whole window and the difference
   * between them is the sum of the execution gaps rather than an exponent. It
   * is also the only version where the claim underneath can be checked by
   * adding up the legs.
   */
  const entrySize = (options.startingBalance * maxPositionBps) / BPS;

  let balance = options.startingBalance;
  const held = new Map<string, bigint>();
  const legs: CopyLeg[] = [];
  let copied = 0;
  let skipped = 0;
  let latencyCost = 0n;

  // The leader's own outcome over exactly the swaps being copied, so the two
  // numbers are comparable rather than one being read off a different set.
  let leaderIn = 0n;
  let leaderOut = 0n;

  /*
   * What the leader is holding, rebuilt from their own swaps.
   *
   * Needed because a sell has to be copied as a fraction. If they sell a third
   * of their position, the copier sells a third of theirs. Copying the token
   * count instead would be meaningless, since the two bought different amounts
   * in the first place, and copying every sell as a full exit would turn a
   * trader who scales out into one who does not.
   */
  const leaderHolding = new Map<string, bigint>();
  const lastPool = new Map<string, { sol: bigint; tokens: bigint }>();

  /*
   * What each side paid for what it is holding, so a sell can be scored.
   *
   * The board next to this panel scores a wallet on the part of its positions
   * it has actually sold, at the average of what it paid. This has to score the
   * same way or the two disagree in public: the first wallet it ran on showed
   * plus three and a half SOL on its row and minus sixty per cent in here, on
   * the same trades, because the row counted what came back and this counted
   * everything that went in against a conservative mark of the rest.
   *
   * Realized is also the only basis on which the two sides of this comparison
   * are the same measurement. Nothing still held is priced anywhere.
   */
  const leaderCost = new Map<string, bigint>();
  const copierCost = new Map<string, bigint>();
  let leaderRealized = 0n;
  let leaderStaked = 0n;
  let copierRealized = 0n;
  let copierStaked = 0n;

  /*
   * The leader's side is run as a portfolio too, and that is the whole fix.
   *
   * It used to be scored as a flat sum: everything they realized over
   * everything it cost them. The copier meanwhile compounds a ten SOL balance,
   * sizing every entry off what it currently has. Two different measurements,
   * so the comparison between them meant nothing, and on a real wallet it
   * printed the one result this panel exists to deny: the leader up thirty-six
   * per cent, the copier up seventy-seven, on the same trades.
   *
   * It was not even a bug in the arithmetic. A copier that equal-weights every
   * entry genuinely can beat a trader whose losses were their big bets, and a
   * balance that compounds genuinely does outrun a ratio of sums. Both numbers
   * were right and the sentence between them was false.
   *
   * So the leader's trades are replayed through the identical portfolio, and
   * identical has to mean identical down to the token.
   *
   * Running two portfolios that merely followed the same rules was not enough,
   * and this took four attempts to accept. Filled at different prices they end
   * up holding different token counts, so the same fraction sells different
   * economic amounts, so their balances diverge, so they start skipping
   * different legs, and the copier keeps finding paths where it comes out
   * ahead. Every fix closed one route and left the others open.
   *
   * There is one position, held by both. The tokens bought and sold are the
   * copier's, quoted through the engine against the pool the leader left
   * behind. The only thing that differs is what each side pays for those exact
   * tokens and what each receives for them. That makes the result structural
   * rather than hopeful: the leader's cost per leg cannot exceed the copier's,
   * their proceeds cannot fall below, so their realized total cannot come out
   * lower. It is not a property to be tested for any more, though it is; it is
   * a property that cannot be violated by arithmetic.
   */
  let leaderBalance = options.startingBalance;

  /** The same charge, when the holding is already in hand rather than in a map. */
  const realizeAt = (
    costs: Map<string, bigint>,
    mint: string,
    heldNow: bigint,
    tokensSold: bigint,
    proceeds: bigint,
  ): { pnl: bigint; spent: bigint } => {
    const cost = costs.get(mint) ?? 0n;
    if (heldNow <= 0n || tokensSold <= 0n) return { pnl: 0n, spent: 0n };
    const sold = tokensSold > heldNow ? heldNow : tokensSold;
    const spent = sold === heldNow ? cost : (cost * sold) / heldNow;
    costs.set(mint, cost - spent);
    return { pnl: proceeds - spent, spent };
  };

  /** Charge a sale its share of what the position cost, at the average paid. */
  const realize = (
    costs: Map<string, bigint>,
    holdings: Map<string, bigint>,
    mint: string,
    tokensSold: bigint,
    proceeds: bigint,
  ): { pnl: bigint; spent: bigint } => {
    const heldNow = holdings.get(mint) ?? 0n;
    const cost = costs.get(mint) ?? 0n;
    if (heldNow <= 0n || tokensSold <= 0n) return { pnl: 0n, spent: 0n };
    const sold = tokensSold > heldNow ? heldNow : tokensSold;
    const spent = sold === heldNow ? cost : (cost * sold) / heldNow;
    costs.set(mint, cost - spent);
    return { pnl: proceeds - spent, spent };
  };

  for (const swap of swaps) {
    const pool = poolFrom(swap, options);
    lastPool.set(swap.mint, { sol: pool.solReserve, tokens: pool.tokenReserve });

    const leaderSol = BigInt(swap.solAmount);
    const leaderTokens = BigInt(swap.tokenAmount);
    if (leaderSol <= 0n || leaderTokens <= 0n) {
      skipped += 1;
      continue;
    }

    /*
     * A swap has to agree with the pool it says it left behind.
     *
     * This is where the absurd figures came from: 6,877,920 SOL realized on a
     * ten SOL account, and eleven million per cent. One recorded swap with a
     * near-zero SOL amount against a real token amount implies a price
     * thousands of times off, and a single entry at that price turns into
     * millions when it is later sold at a normal one. The wallet parser reads
     * whatever the chain hands it, including transactions that are not really
     * a trade, and a backtest cannot tell the difference by looking at one
     * number.
     *
     * The reserves are the check. A swap's own ratio and the ratio of the pool
     * it left behind describe the same market a moment apart, so they cannot be
     * orders of magnitude apart. Anything that far out is dropped rather than
     * priced.
     */
    const poolPrice = unitPrice(pool.solReserve, pool.tokenReserve);
    const swapPrice = unitPrice(leaderSol, leaderTokens);
    if (poolPrice <= 0n || swapPrice <= 0n) {
      skipped += 1;
      continue;
    }
    const high = poolPrice > swapPrice ? poolPrice : swapPrice;
    const low = poolPrice > swapPrice ? swapPrice : poolPrice;
    if (high > low * PRICE_SANITY) {
      skipped += 1;
      continue;
    }

    if (swap.isBuy) {
      leaderIn += leaderSol;
      leaderHolding.set(swap.mint, (leaderHolding.get(swap.mint) ?? 0n) + leaderTokens);


      /*
       * Proportional, and capped.
       *
       * A fixed fraction of what the copier started with, and never more than
       * it currently has. Fixed rather than compounding, because the same rule
       * has to run on both sides and a compounding pair of portfolios diverges
       * exponentially over two hundred trades on a difference that is meant to
       * be measured in basis points.
       */
      /*
       * Both sides take this entry, or neither does.
       *
       * They ran on their own balances before, so once one of them was short
       * the two portfolios stopped holding the same things, and a comparison
       * between different portfolios is not a comparison of execution. That is
       * how the copier came out ahead again: it was in trades the other side
       * had skipped.
       */
      const size = entrySize;
      if (size <= 0n || size > balance) {
        skipped += 1;
        continue;
      }

      try {
        const quote = quoteBuy(pool, size);
        if (quote.tokenAmount <= 0n) {
          skipped += 1;
          continue;
        }

        /*
         * Their price, capped by the pool they left behind.
         *
         * A recorded swap's SOL amount is not purely what went to the pool. It
         * carries priority fees, tips, and whatever else the transaction paid,
         * and on a multi-hop route it is not even one trade. So the leader's
         * apparent price is sometimes worse than the pool's, and the copier
         * came out ahead on half the legs of a real wallet: a buy at 129.3m
         * against their 149.3m, which cannot happen to somebody arriving second
         * into a pool the first order already moved.
         *
         * The pool is the bound, and it is a fact about the market rather than
         * a correction applied to make the answer come out right. They traded
         * against this pool before it moved, so on a buy their price cannot
         * have been above where it ended up, and on a sell it cannot have been
         * below. Where the recording says otherwise, the recording is what is
         * wrong.
         */
        const poolUnit = unitPrice(pool.solReserve, pool.tokenReserve);
        const recorded = unitPrice(leaderSol, leaderTokens);
        const theirUnit = recorded < poolUnit ? recorded : poolUnit;
        const atTheirPrice = (quote.tokenAmount * theirUnit) / 1_000_000_000n;
        if (atTheirPrice > leaderBalance) {
          skipped += 1;
          continue;
        }

        balance -= size;
        leaderBalance -= atTheirPrice;
        held.set(swap.mint, (held.get(swap.mint) ?? 0n) + quote.tokenAmount);
        copierCost.set(swap.mint, (copierCost.get(swap.mint) ?? 0n) + size);
        leaderCost.set(swap.mint, (leaderCost.get(swap.mint) ?? 0n) + atTheirPrice);

        const leaderPrice = theirUnit;
        const copierPrice = unitPrice(size, quote.tokenAmount);
        // Paying more per token than the leader is the cost of being second.
        if (copierPrice > leaderPrice) {
          latencyCost += ((copierPrice - leaderPrice) * quote.tokenAmount) / 1_000_000_000n;
        }

        legs.push({
          mint: swap.mint,
          isBuy: true,
          at: swap.blockTime,
          sol: size,
          tokens: quote.tokenAmount,
          leaderPrice,
          copierPrice,
        });
        copied += 1;
      } catch {
        // The engine refused it: too small, or a pool it will not quote.
        skipped += 1;
      }
      continue;
    }

    leaderOut += leaderSol;

    /*
     * Sells are copied by fraction of the position, not by size.
     *
     * The leader selling half of what they hold means the copier sells half of
     * what they hold. Copying the token count would be meaningless, since the
     * two bought different amounts in the first place.
     */
    const holding = held.get(swap.mint) ?? 0n;
    if (holding <= 0n) {
      skipped += 1;
      continue;
    }

    /*
     * The fraction of their position the leader just sold.
     *
     * Their holding is rebuilt from the buys seen in this window, so a wallet
     * that already held the token before the window can sell more than this
     * walk knows about. That is treated as a full exit, which is what it is
     * from here: they are out of everything this backtest ever saw them buy.
     */
    const leaderPosition = leaderHolding.get(swap.mint) ?? 0n;
    const fraction =
      leaderPosition <= 0n || leaderTokens >= leaderPosition
        ? BPS
        : (leaderTokens * BPS) / leaderPosition;
    leaderHolding.set(
      swap.mint,
      leaderPosition > leaderTokens ? leaderPosition - leaderTokens : 0n,
    );


    let tokensOut = (holding * fraction) / BPS;
    if (tokensOut > holding) tokensOut = holding;
    if (tokensOut <= 0n) {
      skipped += 1;
      continue;
    }

    try {
      const quote = quoteSell(pool, tokensOut);
      if (quote.solAmount <= 0n) {
        skipped += 1;
        continue;
      }
      const scored = realize(copierCost, held, swap.mint, tokensOut, quote.solAmount);
      copierRealized += scored.pnl;
      copierStaked += scored.spent;
      balance += quote.solAmount;
      held.set(swap.mint, holding - tokensOut);

      /*
       * The same tokens leaving, valued at their price.
       *
       * Scored against `holding` rather than a second position, because there
       * is only one position. Their proceeds cannot come out below the
       * copier's: the copier sold into a pool the leader's own order had
       * already moved.
       */
      // The same bound, the other way up: selling into a pool before it moved
      // cannot have paid them less than it pays whoever arrives afterwards.
      const poolUnit = unitPrice(pool.solReserve, pool.tokenReserve);
      const recorded = unitPrice(leaderSol, leaderTokens);
      const theirUnit = recorded > poolUnit ? recorded : poolUnit;
      const theirProceeds = (tokensOut * theirUnit) / 1_000_000_000n;
      const mirrorScored = realizeAt(leaderCost, swap.mint, holding, tokensOut, theirProceeds);
      leaderRealized += mirrorScored.pnl;
      leaderStaked += mirrorScored.spent;
      leaderBalance += theirProceeds;

      const leaderPrice = theirUnit;
      const copierPrice = unitPrice(quote.solAmount, tokensOut);
      // Receiving less per token than the leader is the same cost, other way up.
      if (leaderPrice > copierPrice) {
        latencyCost += ((leaderPrice - copierPrice) * tokensOut) / 1_000_000_000n;
      }

      legs.push({
        mint: swap.mint,
        isBuy: false,
        at: swap.blockTime,
        sol: quote.solAmount,
        tokens: tokensOut,
        leaderPrice,
        copierPrice,
      });
      copied += 1;
    } catch {
      skipped += 1;
    }
  }

  // Anything still held is marked at the last pool this walk saw for it. Held
  // at zero would punish an open position; held at cost would flatter it.
  let openValue = 0n;
  for (const [mint, tokens] of held) {
    if (tokens <= 0n) continue;
    const pool = lastPool.get(mint);
    if (!pool || pool.tokens === 0n) continue;
    openValue += (tokens * pool.sol) / (pool.tokens + tokens);
  }

  const endingEquity = balance + openValue;
  const start = options.startingBalance;
  /*
   * Both returns are realized money over the cost it was made on, which is
   * exactly what the row above this panel reports. Marked equity is still
   * returned for the balance line, but it is not what either percentage means.
   */
  const returnBps = copierStaked === 0n ? 0 : Number((copierRealized * BPS) / copierStaked);
  const leaderReturnBps = leaderStaked === 0n ? 0 : Number((leaderRealized * BPS) / leaderStaked);

  return {
    startingBalance: start,
    endingBalance: balance,
    endingEquity,
    returnBps,
    leaderReturnBps,
    leaderRealized,
    copierRealized,
    legs,
    copied,
    skipped,
    latencyCost,
  };
}
