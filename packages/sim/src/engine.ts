import { BPS_DENOMINATOR, mulDivCeil, mulDivFloor, type Amount } from './fixed';
import { ENGINE_VERSION } from './version';
import { totalFeeBps, type PoolState, type Side } from './types';

/**
 * The fill engine.
 *
 * Pure functions over a pool and a size. No network, no clock, no randomness —
 * the same inputs always produce the same fill, which is what lets step D11
 * replay real historical swaps and check the output against what actually
 * happened.
 *
 * Rounding always favours the pool. What a trader receives is floored, what
 * they pay is ceiled. In curve math the direction you round is the difference
 * between a fair fill and a slow leak of value, and rounding a trader's way
 * would let a leaderboard be farmed a lamport at a time.
 */

export class QuoteError extends Error {
  constructor(
    message: string,
    readonly code: QuoteErrorCode,
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export type QuoteErrorCode =
  | 'non_positive_size'
  | 'empty_reserves'
  | 'no_liquidity'
  | 'dust';

export interface Quote {
  readonly side: Side;
  /** SOL leaving the trader's balance on a buy, arriving on a sell. */
  readonly solAmount: Amount;
  /** Tokens arriving on a buy, leaving on a sell. */
  readonly tokenAmount: Amount;
  /** Total fee taken, in lamports. */
  readonly feeLamports: Amount;
  /** How far the fill's average price sits from the pool's spot price. */
  readonly priceImpactBps: number;
  /** True when the venue could not deliver the whole requested size. */
  readonly partial: boolean;
  /** The engine that produced this. Recorded with every trade. */
  readonly engineVersion: number;
}

function assertQuotable(pool: PoolState): void {
  if (pool.solReserve <= 0n || pool.tokenReserve <= 0n) {
    throw new QuoteError('pool has an empty reserve and cannot be quoted', 'empty_reserves');
  }
}

/**
 * Price impact, in basis points.
 *
 * Compares what the trade actually paid per token against what an
 * infinitesimal trade would have paid. Computed by cross-multiplication rather
 * than by dividing twice, so no intermediate rounding creeps in.
 */
function impactBps(
  solAmount: Amount,
  tokenAmount: Amount,
  solReserve: Amount,
  tokenReserve: Amount,
): number {
  if (tokenAmount === 0n || solAmount === 0n) return 0;

  // spot = solReserve / tokenReserve, executed = solAmount / tokenAmount.
  // impact = executed / spot - 1 = (solAmount * tokenReserve) / (tokenAmount * solReserve) - 1
  const numerator = solAmount * tokenReserve;
  const denominator = tokenAmount * solReserve;
  if (denominator === 0n) return 0;

  const ratioBps = mulDivFloor(numerator, BPS_DENOMINATOR, denominator);
  const impact = ratioBps - BPS_DENOMINATOR;
  // A sell executes below spot, a buy above; the magnitude is what matters.
  return Number(impact < 0n ? -impact : impact);
}

/**
 * Buy tokens with SOL.
 *
 * The fee comes off the input before the curve sees it, which is why the
 * trader's SOL and the amount that actually moves the price differ.
 *
 * The `- 1n` is not a rounding guard of mine — it is in the program, and
 * reproducing it exactly is the difference between matching a real fill and
 * missing it by a lamport.
 */
export function quoteBuy(pool: PoolState, solIn: Amount): Quote {
  if (solIn <= 0n) {
    throw new QuoteError('buy size must be positive', 'non_positive_size');
  }
  assertQuotable(pool);

  const feeBps = BigInt(totalFeeBps(pool.fees));
  const afterFee = mulDivFloor(
    solIn > 0n ? solIn - 1n : 0n,
    BPS_DENOMINATOR,
    BPS_DENOMINATOR + feeBps,
  );

  if (afterFee <= 0n) {
    throw new QuoteError('buy is too small to survive the fee', 'dust');
  }

  const feeLamports = solIn - afterFee;
  const uncapped = mulDivFloor(afterFee, pool.tokenReserve, pool.solReserve + afterFee);

  if (uncapped === 0n) {
    throw new QuoteError('buy is too small to receive any tokens', 'dust');
  }

  // A bonding curve prices against virtual reserves but can only hand over the
  // real ones. An AMM sets deliverableTokens to its whole balance, so this is a
  // no-op there.
  const tokenAmount = uncapped > pool.deliverableTokens ? pool.deliverableTokens : uncapped;
  if (tokenAmount === 0n) {
    throw new QuoteError('the venue has no tokens left to sell', 'no_liquidity');
  }

  return {
    side: 'buy',
    solAmount: solIn,
    tokenAmount,
    feeLamports,
    priceImpactBps: impactBps(afterFee, tokenAmount, pool.solReserve, pool.tokenReserve),
    partial: tokenAmount < uncapped,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Sell tokens for SOL.
 *
 * Here the curve runs first and the fee comes off the output, which is the
 * mirror of the buy path and not merely the same calculation reversed.
 */
export function quoteSell(pool: PoolState, tokensIn: Amount): Quote {
  if (tokensIn <= 0n) {
    throw new QuoteError('sell size must be positive', 'non_positive_size');
  }
  assertQuotable(pool);

  const grossSol = mulDivFloor(tokensIn, pool.solReserve, pool.tokenReserve + tokensIn);
  if (grossSol === 0n) {
    throw new QuoteError('sell is too small to return any SOL', 'dust');
  }

  const feeBps = BigInt(totalFeeBps(pool.fees));
  const feeLamports = mulDivCeil(grossSol, feeBps, BPS_DENOMINATOR);
  const solOut = grossSol > feeLamports ? grossSol - feeLamports : 0n;

  if (solOut === 0n) {
    throw new QuoteError('the fee consumes the entire proceeds of this sell', 'dust');
  }

  return {
    side: 'sell',
    solAmount: solOut,
    tokenAmount: tokensIn,
    feeLamports,
    priceImpactBps: impactBps(grossSol, tokensIn, pool.solReserve, pool.tokenReserve),
    partial: false,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * The pool as it stands after a fill.
 *
 * Needed to quote a second trade against the same reading — a position closing
 * in two parts, or the replay harness stepping through a block — without going
 * back to chain.
 *
 * Fees leave the pool rather than joining the reserves, which is what keeps the
 * constant product honest: they are paid out to the protocol and the creator,
 * not retained as liquidity.
 */
export function applyQuote(pool: PoolState, quote: Quote): PoolState {
  if (quote.side === 'buy') {
    const intoCurve = quote.solAmount - quote.feeLamports;
    return {
      ...pool,
      solReserve: pool.solReserve + intoCurve,
      tokenReserve: pool.tokenReserve - quote.tokenAmount,
      deliverableTokens: pool.deliverableTokens - quote.tokenAmount,
    };
  }

  const outOfCurve = quote.solAmount + quote.feeLamports;
  return {
    ...pool,
    solReserve: pool.solReserve > outOfCurve ? pool.solReserve - outOfCurve : 0n,
    tokenReserve: pool.tokenReserve + quote.tokenAmount,
    deliverableTokens: pool.deliverableTokens + quote.tokenAmount,
  };
}
