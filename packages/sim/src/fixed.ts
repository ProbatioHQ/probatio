/**
 * Fixed-point integer arithmetic.
 *
 * Every amount in Probatio is a bigint in the asset's smallest unit — lamports
 * for SOL, base units for SPL tokens. Floating point never touches a balance,
 * a fill, a fee or a PnL figure.
 *
 * The reason is not pedantry. A float carries ~15 significant digits, and a
 * lamport balance can need 19. Errors that look invisible at one trade compound
 * across thousands, and this project's entire claim is that a record can be
 * independently recomputed and will match. It cannot match if the arithmetic
 * drifts.
 *
 * Rounding is always explicit. There is no default, because in curve math the
 * direction you round is the difference between a fair fill and a slow leak of
 * value out of the pool.
 */

/** An amount in an asset's smallest indivisible unit. Never negative. */
export type Amount = bigint;

/** Denominator for basis points. 10_000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000n;

export class FixedPointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixedPointError';
  }
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new FixedPointError(`${label} must be non-negative, got ${value}`);
  }
}

function assertPositive(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new FixedPointError(`${label} must be positive, got ${value}`);
  }
}

/**
 * (a * b) / d, truncated toward zero.
 *
 * Use when the result is what the trader *receives*: rounding down keeps the
 * remainder with the pool, which is the safe direction.
 */
export function mulDivFloor(a: Amount, b: Amount, d: Amount): Amount {
  assertNonNegative(a, 'a');
  assertNonNegative(b, 'b');
  assertPositive(d, 'divisor');
  return (a * b) / d;
}

/**
 * (a * b) / d, rounded away from zero.
 *
 * Use when the result is what the trader *pays*: rounding up keeps the
 * remainder with the pool, which is again the safe direction.
 */
export function mulDivCeil(a: Amount, b: Amount, d: Amount): Amount {
  assertNonNegative(a, 'a');
  assertNonNegative(b, 'b');
  assertPositive(d, 'divisor');
  const product = a * b;
  if (product === 0n) return 0n;
  return (product + d - 1n) / d;
}

/**
 * The portion of `amount` represented by `bps` basis points, rounded up.
 *
 * Fees round up so the pool is never shortchanged by a fraction of a unit.
 */
export function feeOf(amount: Amount, bps: number): Amount {
  assertNonNegative(amount, 'amount');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new FixedPointError(`bps must be an integer in [0, 10000], got ${bps}`);
  }
  return mulDivCeil(amount, BigInt(bps), BPS_DENOMINATOR);
}

/** `amount` with a `bps` fee removed. Never returns a negative. */
export function subtractFee(amount: Amount, bps: number): Amount {
  const fee = feeOf(amount, bps);
  return amount - fee;
}

/**
 * Render a raw base-unit amount as a decimal string for display only.
 *
 * The output of this function must never be parsed back into arithmetic, and
 * must never be stored. It exists so a human can read a number.
 */
export function formatAmount(raw: Amount, decimals: number): string {
  assertNonNegative(raw, 'raw');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 32) {
    throw new FixedPointError(`decimals must be an integer in [0, 32], got ${decimals}`);
  }
  if (decimals === 0) return raw.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = raw % scale;
  if (fraction === 0n) return whole.toString();

  const padded = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${padded}`;
}

/**
 * Parse a decimal string into base units.
 *
 * Rejects anything it cannot represent exactly rather than silently truncating —
 * a quietly dropped digit is precisely the kind of drift this module exists to
 * prevent.
 */
export function parseAmount(input: string, decimals: number): Amount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 32) {
    throw new FixedPointError(`decimals must be an integer in [0, 32], got ${decimals}`);
  }

  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new FixedPointError(`not a valid non-negative decimal: "${input}"`);
  }

  const [wholePart = '0', fractionPart = ''] = trimmed.split('.');
  if (fractionPart.length > decimals) {
    throw new FixedPointError(
      `"${input}" has ${fractionPart.length} decimal places but the asset supports ${decimals}`,
    );
  }

  const scale = 10n ** BigInt(decimals);
  const fractionScaled = BigInt(fractionPart.padEnd(decimals, '0') || '0');
  return BigInt(wholePart) * scale + fractionScaled;
}
