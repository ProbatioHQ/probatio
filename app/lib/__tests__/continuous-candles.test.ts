import { describe, expect, it } from 'vitest';
import { MAX_FILLED, continuous, type WireCandle } from '../continuous-candles';

/**
 * The chart reads what this returns. Every case here was a way the chart looked
 * broken before: floating dashes with no body, a line teleporting across a gap,
 * a candle whose wick did not reach its own open.
 */

function candle(time: number, open: string, high: string, low: string, close: string, trades = 1): WireCandle {
  return { time, open, high, low, close, volume: '1', trades };
}

describe('continuous', () => {
  it('opens each candle at the previous close, so a single trade has a body', () => {
    // Two buckets, one trade each. Stored, both are dojis: open equals close.
    const out = continuous(
      [candle(60, '100', '100', '100', '100'), candle(120, '110', '110', '110', '110')],
      60,
    );

    // The second candle now opens where the first closed and closes at its
    // trade: a real body from 100 to 110, not a dash floating at 110.
    expect(out[1]!.open).toBe('100');
    expect(out[1]!.close).toBe('110');
    expect(out[1]!.open).not.toBe(out[1]!.close);
  });

  it('leaves the first candle opening at its own price', () => {
    const out = continuous([candle(60, '100', '105', '95', '102')], 60);
    expect(out[0]!.open).toBe('100');
  });

  it('fills untraded buckets flat at the last close', () => {
    // A gap of three minutes between two trades.
    const out = continuous(
      [candle(60, '100', '100', '100', '100'), candle(300, '130', '130', '130', '130')],
      60,
    );

    // 60, then 120/180/240 filled, then 300: no holes, one bucket per minute.
    expect(out.map((c) => c.time)).toEqual([60, 120, 180, 240, 300]);
    for (const time of [120, 180, 240]) {
      const filled = out.find((c) => c.time === time)!;
      expect(filled.open).toBe('100');
      expect(filled.close).toBe('100');
      expect(filled.high).toBe('100');
      expect(filled.low).toBe('100');
      expect(filled.trades).toBe(0);
      expect(filled.volume).toBe('0');
    }
  });

  it('widens the high and low to take in the stitched open', () => {
    // A down candle whose stored range sits entirely below the previous close.
    const out = continuous(
      [candle(60, '200', '200', '200', '200'), candle(120, '150', '160', '140', '150')],
      60,
    );

    // Opening at 200 and closing at 150, the high must reach the open and the
    // low must still be the trade's low, or the wick would not touch the body.
    expect(out[1]!.open).toBe('200');
    expect(out[1]!.high).toBe('200');
    expect(out[1]!.low).toBe('140');
    // Never invalid: high >= max(open, close), low <= min(open, close).
    for (const c of out) {
      expect(BigInt(c.high)).toBeGreaterThanOrEqual(BigInt(c.open) > BigInt(c.close) ? BigInt(c.open) : BigInt(c.close));
      expect(BigInt(c.low)).toBeLessThanOrEqual(BigInt(c.open) < BigInt(c.close) ? BigInt(c.open) : BigInt(c.close));
    }
  });

  it('compares prices as numbers, not as strings', () => {
    // '9' sorts after '10' lexically; the widening must use the integer values.
    const out = continuous(
      [candle(60, '9', '9', '9', '9'), candle(120, '10', '10', '10', '10')],
      60,
    );
    expect(out[1]!.open).toBe('9');
    expect(out[1]!.high).toBe('10');
    expect(out[1]!.low).toBe('9');
  });

  it('caps the fill so an idle token cannot generate an unbounded series', () => {
    // A gap far larger than the cap: fills stop and the remaining hole is left.
    const size = 60;
    const far = 60 + (MAX_FILLED + 500) * size;
    const out = continuous([candle(60, '100', '100', '100', '100'), candle(far, '100', '100', '100', '100')], size);
    // Two real candles plus at most the cap of fills.
    expect(out.length).toBeLessThanOrEqual(2 + MAX_FILLED);
    expect(out.length).toBe(2 + MAX_FILLED);
  });

  it('returns an empty series untouched', () => {
    expect(continuous([], 60)).toEqual([]);
  });

  it('does not fill when the size is unknown', () => {
    const input = [candle(60, '100', '100', '100', '100'), candle(300, '110', '110', '110', '110')];
    expect(continuous(input, 0)).toHaveLength(2);
  });
});
