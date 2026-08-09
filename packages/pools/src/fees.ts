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
 * D11 replays real swaps against the engine, and any gap between these figures
 * and reality shows up there as error rather than staying hidden.
 */

/** Bonding curve: 1.25% total, split 0.95% protocol and 0.30% creator. */
export const PUMPFUN_CURVE_FEES: FeeSchedule = Object.freeze({
  protocolBps: 95,
  creatorBps: 30,
  lpBps: 0,
});

/**
 * PumpSwap starts at the same 1.25% for a freshly graduated coin and falls
 * toward 0.30% as market cap climbs. The high end is used because it is the
 * conservative direction: quoting a trader a worse fill than they would really
 * get is a smaller sin than quoting a better one.
 */
export const PUMPSWAP_DEFAULT_FEES: FeeSchedule = Object.freeze({
  protocolBps: 95,
  creatorBps: 30,
  lpBps: 0,
});
