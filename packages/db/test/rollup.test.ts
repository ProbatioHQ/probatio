import { describe, expect, it } from 'vitest';
import { rollupCandles } from '../src/candles';
import type { StoredCandle } from '../src/candles';

function candle(openTime: number, o: string, h: string, l: string, c: string, v = '0', t = 1): StoredCandle {
  return { openTime, open: o, high: h, low: l, close: c, volume: v, trades: t };
}

const HOUR = 3_600;
const DAY = 24 * HOUR;

describe('rollupCandles', () => {
  it('combines hourly candles into a day, keeping open first and close last', () => {
    // Three hours inside the same day, ascending.
    const hourly: StoredCandle[] = [
      candle(0, '100', '120', '90', '110', '5', 2),
      candle(HOUR, '110', '150', '105', '130', '7', 3),
      candle(2 * HOUR, '130', '140', '80', '95', '3', 1),
    ];

    const day = rollupCandles(hourly, DAY);

    expect(day).toHaveLength(1);
    expect(day[0]).toEqual({
      openTime: 0,
      open: '100', // first candle's open
      high: '150', // widest high
      low: '80', // deepest low
      close: '95', // last candle's close
      volume: '15', // summed
      trades: 6, // summed
    });
  });

  it('separates candles that fall in different days', () => {
    const hourly: StoredCandle[] = [
      candle(0, '10', '10', '10', '10'),
      candle(DAY + HOUR, '20', '20', '20', '20'),
    ];

    const days = rollupCandles(hourly, DAY);
    expect(days.map((d) => d.openTime)).toEqual([0, DAY]);
  });

  it('compares prices as numbers, not strings', () => {
    // '9' > '100' as strings; must be treated as integers so the high is 100.
    const hourly: StoredCandle[] = [
      candle(0, '9', '9', '9', '9'),
      candle(HOUR, '100', '100', '100', '100'),
    ];
    expect(rollupCandles(hourly, DAY)[0]!.high).toBe('100');
    expect(rollupCandles(hourly, DAY)[0]!.low).toBe('9');
  });

  it('is empty for no input', () => {
    expect(rollupCandles([], DAY)).toEqual([]);
  });
});
