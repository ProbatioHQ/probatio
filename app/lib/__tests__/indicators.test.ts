import { describe, expect, it } from 'vitest';
import { bollinger, ema, macd, rsi, sma, vwap, type Bar } from '../indicators';

/** Bars from a list of closes; highs/lows/volume default around the close. */
function bars(closes: number[], volumes?: number[]): Bar[] {
  return closes.map((close, i) => ({
    time: i,
    high: close,
    low: close,
    close,
    volume: volumes?.[i] ?? 1,
  }));
}

describe('sma', () => {
  it('averages the last N closes, aligned to the closing candle', () => {
    const out = sma(bars([1, 2, 3, 4, 5]), 3);
    expect(out).toEqual([
      { time: 2, value: 2 }, // (1+2+3)/3
      { time: 3, value: 3 }, // (2+3+4)/3
      { time: 4, value: 4 }, // (3+4+5)/3
    ]);
  });

  it('is empty when there is less than one period', () => {
    expect(sma(bars([1, 2]), 3)).toEqual([]);
  });
});

describe('ema', () => {
  it('seeds with the SMA then smooths', () => {
    const out = ema(bars([1, 2, 3, 4, 5]), 3);
    // seed = (1+2+3)/3 = 2; k = 2/4 = 0.5
    expect(out[0]).toEqual({ time: 2, value: 2 });
    expect(out[1]!.value).toBeCloseTo(4 * 0.5 + 2 * 0.5, 10); // 3
    expect(out[2]!.value).toBeCloseTo(5 * 0.5 + 3 * 0.5, 10); // 4
  });
});

describe('rsi', () => {
  it('is 100 when every move is up', () => {
    const out = rsi(bars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 14);
    expect(out[0]!.value).toBe(100);
  });

  it('sits near 50 for an alternating walk', () => {
    const walk = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const out = rsi(bars(walk), 14);
    expect(out.at(-1)!.value).toBeGreaterThan(30);
    expect(out.at(-1)!.value).toBeLessThan(70);
  });
});

describe('bollinger', () => {
  it('centres on the SMA with a symmetric band', () => {
    const { upper, middle, lower } = bollinger(bars([2, 4, 6, 8, 10]), 5, 2);
    expect(middle[0]).toEqual({ time: 4, value: 6 }); // mean of 2..10
    // std dev of [2,4,6,8,10] (population) = sqrt(8) ≈ 2.828
    expect(upper[0]!.value).toBeCloseTo(6 + 2 * Math.sqrt(8), 6);
    expect(lower[0]!.value).toBeCloseTo(6 - 2 * Math.sqrt(8), 6);
  });
});

describe('vwap', () => {
  it('weights the typical price by volume, cumulatively', () => {
    const out = vwap(bars([10, 20], [1, 3]));
    expect(out[0]!.value).toBe(10); // first bar: just its typical price
    // second: (10*1 + 20*3) / (1+3) = 70/4 = 17.5
    expect(out[1]!.value).toBe(17.5);
  });
});

describe('macd', () => {
  it('is zero when fast and slow EMAs coincide (flat series)', () => {
    const flat = bars(Array.from({ length: 40 }, () => 5));
    const { macd: line, signal, histogram } = macd(flat, 12, 26, 9);
    expect(line.at(-1)!.value).toBeCloseTo(0, 10);
    expect(signal.at(-1)!.value).toBeCloseTo(0, 10);
    expect(histogram.at(-1)!.value).toBeCloseTo(0, 10);
  });

  it('is positive while price is trending up', () => {
    const rising = bars(Array.from({ length: 60 }, (_, i) => 100 + i));
    expect(macd(rising, 12, 26, 9).macd.at(-1)!.value).toBeGreaterThan(0);
  });
});
