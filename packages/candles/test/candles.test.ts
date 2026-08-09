import { describe, expect, it } from 'vitest';
import {
  CandleError,
  bucketStart,
  buildCandles,
  fillGaps,
  mergeCandles,
  timeframeSeconds,
  type Candle,
  type Observation,
} from '../src/candles';
import { PRICE_SCALE, PriceError, marketCapLamports, priceFromReserves, priceToNumber } from '../src/price';

function observation(timestamp: number, price: bigint, volume = 1_000n): Observation {
  return { timestamp, price, volumeLamports: volume };
}

describe('priceFromReserves', () => {
  it('is exact fixed point', () => {
    // 1 SOL against 1e9 base units = 1 lamport per base unit.
    expect(priceFromReserves(1_000_000_000n, 1_000_000_000n)).toBe(PRICE_SCALE);
  });

  it('keeps precision on a real memecoin price', () => {
    // Reserves taken from a live curve.
    const price = priceFromReserves(31_568_852_706n, 1_019_675_959_844_655n);
    // The exact fixed-point value. This is the assertion that matters — it is
    // computed entirely in integers and cannot drift.
    expect(price).toBe(30_959_691_067_748n);
    // The display conversion is lossy by design, so it is only checked loosely.
    expect(priceToNumber(price)).toBeCloseTo(0.0000309597, 10);
  });

  it('refuses a zero token reserve', () => {
    expect(() => priceFromReserves(1n, 0n)).toThrow(PriceError);
  });

  it('refuses a negative sol reserve', () => {
    expect(() => priceFromReserves(-1n, 1n)).toThrow(PriceError);
  });
});

describe('marketCapLamports', () => {
  it('multiplies price by supply', () => {
    const price = priceFromReserves(30_000_000_000n, 1_000_000_000_000_000n);
    // 1e15 base units of supply at that price.
    expect(marketCapLamports(price, 1_000_000_000_000_000n)).toBe(30_000_000_000n);
  });
});

describe('bucketStart', () => {
  it('floors to the timeframe', () => {
    expect(bucketStart(1_786_278_374, 'm1')).toBe(1_786_278_360);
    expect(bucketStart(1_786_278_374, 's5')).toBe(1_786_278_370);
    expect(bucketStart(1_786_278_374, 'h1')).toBe(1_786_276_800);
  });

  it('is idempotent on an exact boundary', () => {
    const start = bucketStart(1_786_278_374, 'm1');
    expect(bucketStart(start, 'm1')).toBe(start);
  });
});

describe('buildCandles', () => {
  it('returns nothing for no observations', () => {
    expect(buildCandles([], 'm1')).toEqual([]);
  });

  it('builds one candle from one observation', () => {
    const [candle] = buildCandles([observation(100, 5n)], 'm1');
    expect(candle).toEqual({
      openTime: 60,
      open: 5n,
      high: 5n,
      low: 5n,
      close: 5n,
      volumeLamports: 1_000n,
      trades: 1,
    });
  });

  it('tracks open, high, low and close in order', () => {
    const [candle] = buildCandles(
      [observation(60, 10n), observation(61, 20n), observation(62, 5n), observation(63, 15n)],
      'm1',
    );
    expect(candle!.open).toBe(10n);
    expect(candle!.high).toBe(20n);
    expect(candle!.low).toBe(5n);
    expect(candle!.close).toBe(15n);
    expect(candle!.trades).toBe(4);
    expect(candle!.volumeLamports).toBe(4_000n);
  });

  it('splits observations across buckets', () => {
    const candles = buildCandles([observation(59, 10n), observation(60, 20n)], 'm1');
    expect(candles).toHaveLength(2);
    expect(candles[0]!.openTime).toBe(0);
    expect(candles[1]!.openTime).toBe(60);
  });

  it('sorts observations that arrive newest first', () => {
    // Chain history comes back in reverse. Assuming order here would invert
    // every candle's open and close.
    const candles = buildCandles([observation(62, 30n), observation(60, 10n), observation(61, 20n)], 'm1');
    expect(candles).toHaveLength(1);
    expect(candles[0]!.open).toBe(10n);
    expect(candles[0]!.close).toBe(30n);
  });

  it('keeps input order for observations sharing a timestamp', () => {
    // Several trades routinely land in the same second, and the block order is
    // the only truth about which came last.
    const candles = buildCandles([observation(60, 10n), observation(60, 20n), observation(60, 15n)], 'm1');
    expect(candles[0]!.open).toBe(10n);
    expect(candles[0]!.close).toBe(15n);
    expect(candles[0]!.high).toBe(20n);
  });

  it('rejects a non-positive price', () => {
    expect(() => buildCandles([observation(60, 0n)], 'm1')).toThrow(CandleError);
    expect(() => buildCandles([observation(60, -1n)], 'm1')).toThrow(CandleError);
  });

  it('always aligns open times to the timeframe', () => {
    for (const timeframe of ['s1', 's5', 'm1', 'h1'] as const) {
      const candles = buildCandles([observation(1_786_278_374, 5n)], timeframe);
      expect(candles[0]!.openTime % timeframeSeconds(timeframe)).toBe(0);
    }
  });
});

describe('fillGaps', () => {
  it('inserts flat candles where nothing traded', () => {
    const candles = buildCandles([observation(0, 10n), observation(180, 20n)], 'm1');
    const filled = fillGaps(candles, 'm1');

    // Without this a chart shows the price teleporting across the gap, when
    // what actually happened is that nobody traded.
    expect(filled.map((c) => c.openTime)).toEqual([0, 60, 120, 180]);
    expect(filled[1]!.open).toBe(10n);
    expect(filled[1]!.close).toBe(10n);
    expect(filled[1]!.volumeLamports).toBe(0n);
    expect(filled[1]!.trades).toBe(0);
  });

  it('leaves an unbroken series alone', () => {
    const candles = buildCandles([observation(0, 10n), observation(60, 20n)], 'm1');
    expect(fillGaps(candles, 'm1')).toHaveLength(2);
  });

  it('handles zero or one candle', () => {
    expect(fillGaps([], 'm1')).toEqual([]);
    const one = buildCandles([observation(0, 10n)], 'm1');
    expect(fillGaps(one, 'm1')).toHaveLength(1);
  });

  it('stops at the cap rather than generating a gap of a week', () => {
    // One trade last week and one today would otherwise produce hundreds of
    // thousands of empty candles.
    const candles = buildCandles([observation(0, 10n), observation(1_000_000, 20n)], 'm1');
    expect(fillGaps(candles, 'm1', 100)).toHaveLength(100);
  });
});

describe('mergeCandles', () => {
  const stored: Candle[] = [
    { openTime: 60, open: 10n, high: 15n, low: 8n, close: 12n, volumeLamports: 100n, trades: 3 },
  ];

  it('combines an overlapping bucket instead of replacing it', () => {
    // The last stored candle is usually still open. Replacing it would throw
    // away the trades already recorded in the same minute.
    const merged = mergeCandles(stored, [
      { openTime: 60, open: 12n, high: 20n, low: 11n, close: 18n, volumeLamports: 50n, trades: 2 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.open).toBe(10n);
    expect(merged[0]!.close).toBe(18n);
    expect(merged[0]!.high).toBe(20n);
    expect(merged[0]!.low).toBe(8n);
    expect(merged[0]!.volumeLamports).toBe(150n);
    expect(merged[0]!.trades).toBe(5);
  });

  it('keeps the lower low and higher high from either side', () => {
    const merged = mergeCandles(stored, [
      { openTime: 60, open: 12n, high: 13n, low: 2n, close: 9n, volumeLamports: 1n, trades: 1 },
    ]);
    expect(merged[0]!.high).toBe(15n);
    expect(merged[0]!.low).toBe(2n);
  });

  it('appends non-overlapping buckets in time order', () => {
    const merged = mergeCandles(stored, [
      { openTime: 0, open: 5n, high: 5n, low: 5n, close: 5n, volumeLamports: 1n, trades: 1 },
      { openTime: 120, open: 20n, high: 20n, low: 20n, close: 20n, volumeLamports: 1n, trades: 1 },
    ]);
    expect(merged.map((c) => c.openTime)).toEqual([0, 60, 120]);
  });

  it('is a no-op when nothing new arrives', () => {
    expect(mergeCandles(stored, [])).toEqual(stored);
  });
});
