/**
 * Turning stored candles into a series a chart can be read from.
 *
 * The candle store keeps one candle per bucket that saw a trade, and each such
 * candle opens at its own first trade. Drawn straight, that is two problems at
 * once: the gaps between traded buckets make the line teleport, and a bucket
 * with a single trade has its open equal to its close and renders as a doji, a
 * floating horizontal tick with no body. A lightly traded token becomes nothing
 * but those ticks, which is the "just dots, no bars" a chart cannot be read
 * from.
 *
 * Both are fixed the way every charting tool draws a continuous market, and the
 * fix lives here rather than in the store so the stored candles stay the true
 * per-bucket record the fill engine and the drift monitor rely on.
 */

export interface WireCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

/** Larger of two prices held as 1e18-scaled integer strings. */
function maxScaled(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** Smaller of two prices held as 1e18-scaled integer strings. */
function minScaled(a: string, b: string): string {
  return BigInt(a) <= BigInt(b) ? a : b;
}

/** A cap on inserted candles, so a token idle for a day cannot fill a year. */
export const MAX_FILLED = 2_000;

/**
 * A continuous series with bodies to read, not a scatter of floating dashes.
 *
 * Empty buckets are filled with a flat candle at the last close, because a price
 * does not move when nobody trades. And each real candle is opened at the
 * previous candle's close rather than at its own first trade, so a single trade
 * draws a body from where the market was to where the trade left it; the high
 * and low are widened to take in that open so every candle stays valid.
 *
 * Bounded: past the fill cap a long idle gap is left as a gap rather than
 * turning an hour between two trades into an hour of candles. The first candle
 * has no previous close and keeps its own open.
 */
export function continuous(candles: readonly WireCandle[], size: number): WireCandle[] {
  if (candles.length === 0 || size <= 0) return [...candles];

  const out: WireCandle[] = [];
  let prevClose: string | null = null;
  let inserted = 0;

  for (const candle of candles) {
    // Hold the last level across every untraded bucket since the previous
    // candle, so the line stays where it was instead of jumping to the next
    // trade.
    if (prevClose !== null && inserted < MAX_FILLED) {
      const lastTime = out[out.length - 1]!.time;
      for (
        let time = lastTime + size;
        time < candle.time && inserted < MAX_FILLED;
        time += size
      ) {
        out.push({
          time,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose,
          volume: '0',
          trades: 0,
        });
        inserted += 1;
      }
    }

    // Open where the market last closed, not at this bucket's first trade. That
    // one change is what gives a lightly traded candle a body to read.
    const open = prevClose ?? candle.open;
    out.push({
      time: candle.time,
      open,
      high: maxScaled(candle.high, open),
      low: minScaled(candle.low, open),
      close: candle.close,
      volume: candle.volume,
      trades: candle.trades,
    });
    prevClose = candle.close;
  }

  return out;
}
