import type { FeeSchedule } from '@probatio/sim';

/**
 * What the venues actually charge.
 *
 * These replace the placeholder constants that stood here through C5 and C6.
 * They are still constants rather than reads of the on-chain fee config, and
 * that distinction matters: pump.fun's rates are set by a separate program and
 * PumpSwap's slide with market cap, so a token far up the curve pays less than
 * these say.
 *
 * This block used to end by saying that the replay harness measures any gap
 * between these figures and reality, so nothing could stay hidden. That was the
 * assurance the numbers below rested on and it was not true of both of them.
 * The harness walks a token's *bonding curve*, so it verifies the curve
 * schedule exactly — and never sees a PumpSwap swap. The one schedule nobody
 * could check was the one being described as checked.
 */

/**
 * Bonding curve: 1.25% total, split 0.95% protocol and 0.30% creator.
 *
 * Verified, not asserted. The mainnet replay reproduces real curve fills to the
 * lamport, which it could not do if this were wrong by a basis point.
 */
export const PUMPFUN_CURVE_FEES: FeeSchedule = Object.freeze({
  protocolBps: 95,
  creatorBps: 30,
  lpBps: 0,
});

/**
 * PumpSwap. A copy of the curve's schedule above, and measurably not what
 * PumpSwap charges.
 *
 * `scripts/measure-pumpswap-fees.mts` reads real buys off mainnet and recovers
 * both the total cost and the part the pool keeps. On an established graduated
 * token, across many clean swaps:
 *
 *   total     29–39 bps   (this says 125)
 *   kept by the pool  24–25 bps   (this says 0)
 *
 * Two separate errors. The total is roughly four times too high, and the split
 * claims an AMM retains nothing for its liquidity providers — which the type's
 * own documentation contradicts, and which a constant product growing across
 * every swap disproves.
 *
 * The total is left alone deliberately, and that is a judgement rather than an
 * oversight. PumpSwap's rate really does slide from about 1.25% on a fresh
 * graduate toward 0.30% as market cap climbs, so a single number is wrong
 * somewhere whatever it is, and 125 is wrong in the safe direction: a trader
 * quoted worse than reality has been treated more harshly than the market
 * would, which is the smaller sin. Replacing it with 29 on the evidence of one
 * liquid token would make every freshly graduated token generous, which is the
 * larger one. Thin pools could not be measured — their trades arrive in bundles
 * of several swaps per transaction, which this method cannot separate — so the
 * other end of the range is genuinely unknown rather than merely unmeasured.
 *
 * What it costs to leave: a trader on a migrated token pays four times the real
 * cost while a trader on a curve pays exactly the real cost, and both are
 * ranked against each other for the same prize. That is a fairness question
 * about the season, not only an accuracy one about the engine, and closing it
 * needs the actual sliding schedule rather than a better guess.
 */
export const PUMPSWAP_DEFAULT_FEES: FeeSchedule = Object.freeze({
  protocolBps: 95,
  creatorBps: 30,
  lpBps: 0,
});
