import { mulDivFloor, type Amount } from '@probatio/sim';

/**
 * Prices as fixed-point integers.
 *
 * A price here is lamports per token base unit, which for a live memecoin is
 * around 0.00003 — a number a float represents badly and a database column
 * represents worse. So it is scaled by 1e18 and carried as a bigint, the same
 * discipline every amount in this project follows.
 *
 * The scale is generous on purpose. At 1e18, a price of 1e-12 lamports per base
 * unit still keeps six significant figures, which is far below anything a real
 * market reaches.
 */

export const PRICE_SCALE = 10n ** 18n;

/** A price in lamports per token base unit, scaled by {@link PRICE_SCALE}. */
export type ScaledPrice = bigint;

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceError';
  }
}

/**
 * The price implied by a pair of reserves.
 *
 * This is deliberately the *only* way a price enters the system. Charts,
 * candles and the fill engine all derive from the same reserves, so a chart can
 * never show one number while a fill produces another.
 */
export function priceFromReserves(solReserve: Amount, tokenReserve: Amount): ScaledPrice {
  if (tokenReserve <= 0n) {
    throw new PriceError('cannot price against a zero token reserve');
  }
  if (solReserve < 0n) {
    throw new PriceError('sol reserve cannot be negative');
  }
  return mulDivFloor(solReserve, PRICE_SCALE, tokenReserve);
}

/**
 * Render a scaled price for display only.
 *
 * Returns a plain number, so it must never be fed back into arithmetic. It
 * exists to hand a value to a charting library, which takes doubles regardless.
 */
export function priceToNumber(price: ScaledPrice): number {
  return Number(price) / Number(PRICE_SCALE);
}

/**
 * The market capitalisation implied by a price and a supply, in lamports.
 *
 * Kept here rather than computed ad hoc at call sites so the rounding happens
 * once, in a place with a test.
 */
export function marketCapLamports(price: ScaledPrice, totalSupply: Amount): Amount {
  return mulDivFloor(price, totalSupply, PRICE_SCALE);
}
