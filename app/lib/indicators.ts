/**
 * Chart indicators, computed from candles on the client.
 *
 * Every one of these is derived from the OHLCV the chart already has, so they
 * are exact and need no extra request. Kept pure and framed as plain arrays so
 * they can be tested against known values rather than eyeballed on a chart.
 *
 * Prices arrive already converted to display units (a market cap in dollars, or
 * a price), so an indicator is in the same unit as the candles it sits on.
 */

export interface Bar {
  /** Unix seconds. */
  readonly time: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** In whatever unit volume is charted; only VWAP reads it. */
  readonly volume: number;
}

export interface Point {
  readonly time: number;
  readonly value: number;
}

/** Simple moving average of the close, aligned to the candle it closes on. */
export function sma(bars: readonly Bar[], period: number): Point[] {
  if (period < 1 || bars.length < period) return [];
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i]!.close;
    if (i >= period) sum -= bars[i - period]!.close;
    if (i >= period - 1) out.push({ time: bars[i]!.time, value: sum / period });
  }
  return out;
}

/** Exponential moving average of the close, seeded with the first SMA. */
export function ema(bars: readonly Bar[], period: number): Point[] {
  if (period < 1 || bars.length < period) return [];
  const k = 2 / (period + 1);
  const out: Point[] = [];

  let prev = 0;
  for (let i = 0; i < period; i += 1) prev += bars[i]!.close;
  prev /= period;
  out.push({ time: bars[period - 1]!.time, value: prev });

  for (let i = period; i < bars.length; i += 1) {
    prev = bars[i]!.close * k + prev * (1 - k);
    out.push({ time: bars[i]!.time, value: prev });
  }
  return out;
}

/** EMA over an already-computed series, for the MACD signal line. */
function emaOfPoints(points: readonly Point[], period: number): Point[] {
  if (period < 1 || points.length < period) return [];
  const k = 2 / (period + 1);
  const out: Point[] = [];

  let prev = 0;
  for (let i = 0; i < period; i += 1) prev += points[i]!.value;
  prev /= period;
  out.push({ time: points[period - 1]!.time, value: prev });

  for (let i = period; i < points.length; i += 1) {
    prev = points[i]!.value * k + prev * (1 - k);
    out.push({ time: points[i]!.time, value: prev });
  }
  return out;
}

export interface Bands {
  readonly upper: Point[];
  readonly middle: Point[];
  readonly lower: Point[];
}

/** Bollinger bands: an SMA with a band a number of standard deviations wide. */
export function bollinger(bars: readonly Bar[], period = 20, multiplier = 2): Bands {
  const upper: Point[] = [];
  const middle: Point[] = [];
  const lower: Point[] = [];
  if (bars.length < period) return { upper, middle, lower };

  for (let i = period - 1; i < bars.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += bars[j]!.close;
    const mean = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = bars[j]!.close - mean;
      variance += diff * diff;
    }
    const sd = Math.sqrt(variance / period);

    const time = bars[i]!.time;
    middle.push({ time, value: mean });
    upper.push({ time, value: mean + multiplier * sd });
    lower.push({ time, value: mean - multiplier * sd });
  }
  return { upper, middle, lower };
}

/**
 * Volume-weighted average price, anchored at the first loaded candle.
 *
 * A running average of the typical price weighted by volume. Anchored to the
 * window rather than a session because a memecoin has no sessions, and the
 * window is a token's life so far, which is the anchor that reads sensibly.
 */
export function vwap(bars: readonly Bar[]): Point[] {
  const out: Point[] = [];
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (const bar of bars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    cumulativePriceVolume += typical * bar.volume;
    cumulativeVolume += bar.volume;
    out.push({ time: bar.time, value: cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : typical });
  }
  return out;
}

/** Relative strength index, Wilder's smoothing, 0 to 100. */
export function rsi(bars: readonly Bar[], period = 14): Point[] {
  if (bars.length < period + 1) return [];
  const out: Point[] = [];

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = bars[i]!.close - bars[i - 1]!.close;
    if (change >= 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  const rsiFrom = (gain: number, loss: number): number =>
    loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  out.push({ time: bars[period]!.time, value: rsiFrom(avgGain, avgLoss) });

  for (let i = period + 1; i < bars.length; i += 1) {
    const change = bars[i]!.close - bars[i - 1]!.close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push({ time: bars[i]!.time, value: rsiFrom(avgGain, avgLoss) });
  }
  return out;
}

export interface Macd {
  readonly macd: Point[];
  readonly signal: Point[];
  readonly histogram: Point[];
}

/** MACD: the gap between two EMAs, its own EMA, and the gap between those. */
export function macd(bars: readonly Bar[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const fastEma = ema(bars, fast);
  const slowEma = ema(bars, slow);
  const slowByTime = new Map(slowEma.map((point) => [point.time, point.value]));

  const macdLine: Point[] = [];
  for (const point of fastEma) {
    const slowValue = slowByTime.get(point.time);
    if (slowValue !== undefined) macdLine.push({ time: point.time, value: point.value - slowValue });
  }

  const signal = emaOfPoints(macdLine, signalPeriod);
  const signalByTime = new Map(signal.map((point) => [point.time, point.value]));

  const histogram: Point[] = [];
  for (const point of macdLine) {
    const signalValue = signalByTime.get(point.time);
    if (signalValue !== undefined) histogram.push({ time: point.time, value: point.value - signalValue });
  }

  return { macd: macdLine, signal, histogram };
}
