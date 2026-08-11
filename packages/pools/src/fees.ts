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
 * PumpSwap, when its published schedule cannot be read. A fallback now, not the
 * rate: `PoolReader` reads the real one from PumpSwap's global config account
 * and quotes 30 bps — 20 to liquidity providers, 5 protocol, 5 creator.
 *
 * Kept deliberately at 125 rather than corrected to 30. This value is only
 * reached when the config is unreadable, and a fallback should fail toward
 * quoting a trader worse than the market rather than better. Everything below
 * is the record of how the number was found to be wrong.
 *
 * A copy of the curve's schedule above, and measurably not what PumpSwap
 * charges.
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
 * The total was left at 125 for one pass, on the reasoning that PumpSwap's rate
 * slides from about 1.25% on a fresh graduate toward 0.30% as market cap
 * climbs, so no single number could be right and the high end was at least
 * wrong in the safe direction. That premise was false. There is one global
 * config account holding three flat rates, and the ~0.30% end of the supposed
 * range is simply the rate. Nothing slides.
 *
 * The lesson is the reason this comment survives the fix: the argument for
 * keeping a wrong number was good enough to hold for a pass, and what settled
 * it was reading the account rather than reasoning about the constant.
 */
export const PUMPSWAP_DEFAULT_FEES: FeeSchedule = Object.freeze({
  protocolBps: 95,
  creatorBps: 30,
  lpBps: 0,
});
