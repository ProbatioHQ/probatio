import { BPS_DENOMINATOR, mulDivFloor, type Amount } from './fixed';
import { QuoteError, quoteBuy, quoteSell, type Quote } from './engine';
import { ENGINE_VERSION } from './version';
import type { PoolState, Side } from './types';

/**
 * Turning an accurate quote into an honest fill.
 *
 * The engine answers "what would this trade produce against this pool". This
 * answers "what would actually have happened", which is a different and less
 * flattering question. Between clicking and landing, the price moves, the
 * depth may not be there, and the trade may simply fail.
 *
 * That last part matters most. Real trading in this market fails constantly —
 * slippage, migration, thin books — and a simulator where every click succeeds
 * is dishonest in the trader's favour. It would produce records that look like
 * skill and are really just the absence of friction.
 */

export type RejectReason =
  | 'slippage'
  | 'price_impact'
  | 'no_liquidity'
  | 'dust'
  | 'partial_not_allowed'
  | 'venue_changed';

export interface ExecutionRules {
  /**
   * Delay between clicking and landing, in milliseconds.
   *
   * Deliberately a fixed number rather than a random draw. Real latency
   * varies, but a leaderboard has to be reproducible and independently
   * checkable — a random component would make every record unverifiable and
   * every loss arguable. Everyone gets the same handicap, and the record can be
   * recomputed by anyone.
   */
  readonly latencyMs: number;
  /** How far the price may move against the trader between click and fill. */
  readonly slippageBps: number;
  /** Trades that would move the price more than this are refused outright. */
  readonly maxPriceImpactBps: number;
  /** Whether a trade may fill for less than was asked. */
  readonly allowPartialFills: boolean;
}

export interface FillRequest {
  readonly side: Side;
  readonly size: Amount;
  /** The pool as it stood when the trader clicked. */
  readonly atClick: PoolState;
  /** The pool as it stood once the trade would actually have landed. */
  readonly atFill: PoolState;
  readonly rules: ExecutionRules;
}

export interface FilledOutcome {
  readonly status: 'filled';
  readonly quote: Quote;
  /** What the trader was shown when they clicked. */
  readonly expected: Quote;
  /**
   * How much worse the fill was than the quote, in basis points.
   *
   * Positive means the trader did worse than they were shown, which is the
   * usual direction. Negative means the price moved their way while they
   * waited.
   */
  readonly slippageBps: number;
  readonly latencyMs: number;
  readonly engineVersion: number;
}

export interface RejectedOutcome {
  readonly status: 'rejected';
  readonly reason: RejectReason;
  readonly detail: string;
  /** Present when the trade was quotable but refused on its terms. */
  readonly expected?: Quote;
  readonly engineVersion: number;
}

export type FillOutcome = FilledOutcome | RejectedOutcome;

function quote(pool: PoolState, side: Side, size: Amount): Quote {
  return side === 'buy' ? quoteBuy(pool, size) : quoteSell(pool, size);
}

function reject(reason: RejectReason, detail: string, expected?: Quote): RejectedOutcome {
  return expected
    ? { status: 'rejected', reason, detail, expected, engineVersion: ENGINE_VERSION }
    : { status: 'rejected', reason, detail, engineVersion: ENGINE_VERSION };
}

/**
 * How much worse the received amount is than the expected one, in bps.
 *
 * Measured on whatever the trader receives: tokens on a buy, SOL on a sell.
 */
function shortfallBps(expected: Amount, actual: Amount): number {
  if (expected === 0n) return 0;
  const difference = expected - actual;
  const magnitude = difference < 0n ? -difference : difference;
  const bps = Number(mulDivFloor(magnitude, BPS_DENOMINATOR, expected));
  return difference < 0n ? -bps : bps;
}

/**
 * Simulate what a click would really have done.
 *
 * The quote at click time is what the trader was shown; the quote at fill time
 * is what they would have got. Everything here compares the two.
 */
export function simulateFill(request: FillRequest): FillOutcome {
  const { side, size, atClick, atFill, rules } = request;

  // A pump.fun token can migrate to the AMM at any moment, including while a
  // trade is in flight. A real transaction targeting the curve fails when that
  // happens rather than silently executing somewhere else.
  if (atClick.source !== atFill.source) {
    return reject(
      'venue_changed',
      `the token moved from ${atClick.source} to ${atFill.source} while the trade was in flight`,
    );
  }

  let expected: Quote;
  try {
    expected = quote(atClick, side, size);
  } catch (error) {
    if (error instanceof QuoteError) {
      return reject(error.code === 'no_liquidity' ? 'no_liquidity' : 'dust', error.message);
    }
    throw error;
  }

  if (expected.priceImpactBps > rules.maxPriceImpactBps) {
    return reject(
      'price_impact',
      `this size would move the price ${expected.priceImpactBps}bp, above the ${rules.maxPriceImpactBps}bp limit`,
      expected,
    );
  }

  let actual: Quote;
  try {
    actual = quote(atFill, side, size);
  } catch (error) {
    if (error instanceof QuoteError) {
      return reject(
        error.code === 'no_liquidity' ? 'no_liquidity' : 'dust',
        `the trade was quotable on click but not on landing: ${error.message}`,
        expected,
      );
    }
    throw error;
  }

  // Checked again against the pool that actually filled it, since the price
  // can move enough in flight to turn an acceptable size into a reckless one.
  if (actual.priceImpactBps > rules.maxPriceImpactBps) {
    return reject(
      'price_impact',
      `by the time it landed this size would move the price ${actual.priceImpactBps}bp`,
      expected,
    );
  }

  if (actual.partial && !rules.allowPartialFills) {
    return reject(
      'partial_not_allowed',
      'the venue could only fill part of this size',
      expected,
    );
  }

  const received = side === 'buy' ? 'tokenAmount' : 'solAmount';
  const slippage = shortfallBps(expected[received], actual[received]);

  if (slippage > rules.slippageBps) {
    return reject(
      'slippage',
      `the price moved ${slippage}bp against you, past your ${rules.slippageBps}bp tolerance`,
      expected,
    );
  }

  return {
    status: 'filled',
    quote: actual,
    expected,
    slippageBps: slippage,
    latencyMs: rules.latencyMs,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Default execution conditions.
 *
 * 600ms is roughly a retail click landing a slot or two later — not the
 * co-located best case, and not a disaster either. A season records its own
 * values on chain, so these are only the starting point.
 */
export const DEFAULT_RULES: ExecutionRules = Object.freeze({
  latencyMs: 600,
  slippageBps: 1_000,
  maxPriceImpactBps: 5_000,
  allowPartialFills: true,
});
