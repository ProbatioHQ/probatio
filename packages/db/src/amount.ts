/**
 * The boundary between stored amounts and computed ones.
 *
 * Amounts live in the database as digit strings and live in code as bigints.
 * Every crossing goes through here. The point is that there is no third form —
 * nothing in this system ever holds a monetary value as a `number`, and the
 * only way to get one would be to write a conversion these functions do not
 * offer.
 */

export class AmountEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountEncodingError';
  }
}

const DIGITS_ONLY = /^(0|[1-9]\d*)$/;

/** Encode a bigint for storage. Rejects negatives — balances never go below zero. */
export function encodeAmount(value: bigint): string {
  if (value < 0n) {
    throw new AmountEncodingError(`amounts cannot be negative, got ${value}`);
  }
  return value.toString();
}

/** Decode a stored amount back to a bigint. */
export function decodeAmount(stored: string): bigint {
  if (!DIGITS_ONLY.test(stored)) {
    throw new AmountEncodingError(
      `stored amount is not a canonical non-negative integer: "${stored}"`,
    );
  }
  return BigInt(stored);
}

/**
 * Encode a value that is allowed to be negative — realized PnL, and nothing
 * else so far. Kept separate from {@link encodeAmount} so that allowing a
 * negative is always a deliberate choice at the call site.
 */
export function encodeSignedAmount(value: bigint): string {
  return value.toString();
}

const SIGNED_DIGITS = /^-?(0|[1-9]\d*)$/;

export function decodeSignedAmount(stored: string): bigint {
  if (!SIGNED_DIGITS.test(stored)) {
    throw new AmountEncodingError(`stored signed amount is not canonical: "${stored}"`);
  }
  return BigInt(stored);
}
