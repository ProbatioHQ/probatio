import { describe, expect, it } from 'vitest';
import {
  FixedPointError,
  feeOf,
  formatAmount,
  mulDivCeil,
  mulDivFloor,
  parseAmount,
  subtractFee,
} from '../src/fixed';

describe('mulDivFloor', () => {
  it('truncates toward zero', () => {
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n); // 21/2 = 10.5 -> 10
  });

  it('is exact when the division is exact', () => {
    expect(mulDivFloor(6n, 4n, 3n)).toBe(8n);
  });

  it('holds precision past what a float can represent', () => {
    // 2^53 + 1 survives here but would be lost to a double.
    const beyondFloat = 9_007_199_254_740_993n;
    expect(mulDivFloor(beyondFloat, 1n, 1n)).toBe(beyondFloat);
  });

  it('rejects a zero divisor', () => {
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow(FixedPointError);
  });

  it('rejects negative operands', () => {
    expect(() => mulDivFloor(-1n, 1n, 1n)).toThrow(FixedPointError);
  });
});

describe('mulDivCeil', () => {
  it('rounds away from zero', () => {
    expect(mulDivCeil(7n, 3n, 2n)).toBe(11n); // 21/2 = 10.5 -> 11
  });

  it('does not round up an exact result', () => {
    expect(mulDivCeil(6n, 4n, 3n)).toBe(8n);
  });

  it('returns zero for a zero product', () => {
    expect(mulDivCeil(0n, 5n, 3n)).toBe(0n);
  });
});

describe('rounding direction', () => {
  it('never rounds in the trader’s favour', () => {
    // The pool keeps the fractional remainder in both directions. Whatever the
    // trader receives is floored; whatever they pay is ceiled.
    const received = mulDivFloor(10n, 1n, 3n);
    const paid = mulDivCeil(10n, 1n, 3n);
    expect(received).toBe(3n);
    expect(paid).toBe(4n);
    expect(paid).toBeGreaterThan(received);
  });
});

describe('feeOf', () => {
  it('computes basis points', () => {
    expect(feeOf(1_000_000n, 100)).toBe(10_000n); // 1%
  });

  it('rounds a fee up so the pool is never short', () => {
    expect(feeOf(1n, 1)).toBe(1n); // 0.0001 of 1 unit still costs a unit
  });

  it('charges nothing at zero bps', () => {
    expect(feeOf(1_000_000n, 0)).toBe(0n);
  });

  it('rejects bps outside [0, 10000]', () => {
    expect(() => feeOf(1n, -1)).toThrow(FixedPointError);
    expect(() => feeOf(1n, 10_001)).toThrow(FixedPointError);
    expect(() => feeOf(1n, 1.5)).toThrow(FixedPointError);
  });
});

describe('subtractFee', () => {
  it('leaves the remainder after the fee', () => {
    expect(subtractFee(1_000_000n, 100)).toBe(990_000n);
  });

  it('never goes negative', () => {
    expect(subtractFee(0n, 10_000)).toBe(0n);
  });
});

describe('formatAmount', () => {
  it('places the decimal point', () => {
    expect(formatAmount(1_500_000_000n, 9)).toBe('1.5');
  });

  it('drops trailing zeros', () => {
    expect(formatAmount(1_000_000_000n, 9)).toBe('1');
  });

  it('pads a small fraction', () => {
    expect(formatAmount(1n, 9)).toBe('0.000000001');
  });

  it('passes through when there are no decimals', () => {
    expect(formatAmount(42n, 0)).toBe('42');
  });
});

describe('parseAmount', () => {
  it('scales to base units', () => {
    expect(parseAmount('1.5', 9)).toBe(1_500_000_000n);
  });

  it('accepts a bare integer', () => {
    expect(parseAmount('2', 9)).toBe(2_000_000_000n);
  });

  it('refuses to silently truncate excess precision', () => {
    expect(() => parseAmount('1.0000000001', 9)).toThrow(FixedPointError);
  });

  it('rejects malformed input', () => {
    expect(() => parseAmount('', 9)).toThrow(FixedPointError);
    expect(() => parseAmount('-1', 9)).toThrow(FixedPointError);
    expect(() => parseAmount('1.2.3', 9)).toThrow(FixedPointError);
    expect(() => parseAmount('abc', 9)).toThrow(FixedPointError);
  });

  it('round-trips through formatAmount', () => {
    const cases = ['0', '1', '1.5', '0.000000001', '123456.789'];
    for (const value of cases) {
      expect(formatAmount(parseAmount(value, 9), 9)).toBe(value);
    }
  });
});
