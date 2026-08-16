import 'server-only';
import { readCandles, writeCandles, type Client, type StoredCandle } from '@probatio/db';

/**
 * A token's chart history from pump.fun's own candle service — the exact series
 * pump.fun's chart draws, so the native chart matches it one to one.
 *
 * pump.fun indexes every trade and serves OHLC at every interval from launch,
 * which no third party and no practical on-chain walk reproduces: a quiet old
 * token has no hourly candles from its first months in a general index, and a
 * graduated token's early history sits on a pool a chart no longer follows. The
 * service has all of it, at each interval the chart offers, in one call each.
 *
 * Prices are requested in SOL (`currency=SOL`), the same quote the store holds,
 * and scaled onto the store's fixed-point axis by the live price so history and
 * the live feed meet without a step. Display only: trades still fill against live
 * on-chain reserves and the verifiable record is chain-derived; neither is
 * touched. Fills only buckets the store lacks and rewrites none.
 */

const BASE = 'https://swap-api.pump.fun/v1/coins';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

interface PumpCandle {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/*
 * Each stored timeframe and the pump.fun interval that fills it. These are the
 * timeframes the chart offers, less the sub-15-second ones the live feed owns.
 * The four- and twelve-hour and daily series are stored in their own right (not
 * rolled up from hourly), because pump.fun carries them back to launch where an
 * hourly roll-up would stop short. Week and month roll up from the stored daily.
 */
const TF_INTERVAL: ReadonlyArray<{ timeframe: string; interval: string }> = [
  { timeframe: 's15', interval: '15s' },
  { timeframe: 'm1', interval: '1m' },
  { timeframe: 'm5', interval: '5m' },
  { timeframe: 'm15', interval: '15m' },
  { timeframe: 'h1', interval: '1h' },
  { timeframe: 'h4', interval: '4h' },
  { timeframe: 'h12', interval: '12h' },
  { timeframe: 'd1', interval: '24h' },
];

async function fetchCandles(mint: string, interval: string): Promise<PumpCandle[]> {
  const url = `${BASE}/${mint}/candles?interval=${interval}&limit=1000&currency=SOL`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://pump.fun' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .map((x) => {
        const row = x as Record<string, unknown>;
        return {
          t: Math.floor(Number(row['timestamp']) / 1000),
          o: Number(row['open']),
          h: Number(row['high']),
          l: Number(row['low']),
          c: Number(row['close']),
        };
      })
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0);
  } catch {
    return [];
  }
}

/** Median, robust to the odd noisy candle at the sparse edge of a walk. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** The fewest overlapping candles that make the scale trustworthy. */
const MIN_OVERLAP = 12;

/** The store's fixed-point scale over pump.fun's SOL price, from the live price. */
function scaleFromAnchor(hourly: PumpCandle[], anchorPrice: number): number | null {
  let latest: PumpCandle | null = null;
  for (const g of hourly) {
    if (g.c > 0 && (latest === null || g.t > latest.t)) latest = g;
  }
  if (latest === null) return null;
  const scale = anchorPrice / latest.c;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** The same scale, from where the walk and pump.fun overlap on the hourly. */
function scaleFromOverlap(mineH1: readonly StoredCandle[], hourly: PumpCandle[]): number | null {
  const mineByTime = new Map(
    mineH1.filter((c) => c.trades > 0).map((c) => [c.openTime, Number(c.close)]),
  );
  const ratios: number[] = [];
  for (const g of hourly) {
    const mine = mineByTime.get(g.t);
    if (mine !== undefined && g.c > 0) ratios.push(mine / g.c);
  }
  if (ratios.length < MIN_OVERLAP) return null;
  const scale = median(ratios);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/**
 * Fill a chart's history from pump.fun, scaled onto the store's axis.
 *
 * Given a live price it anchors to that and can run before the walk, so the
 * whole chart — every timeframe, back to launch — is on screen in seconds.
 * Without one it falls back to the walk/pump.fun overlap on the hourly. Fills
 * only buckets the store lacks, rewrites none. Best-effort: an unreachable
 * service leaves the chart as the walk drew it. Returns how many candles it
 * added, or 0 if pump.fun had nothing to give (the caller may then try another
 * source).
 */
export async function splicePumpfunHistory(
  client: Client,
  mint: string,
  anchorPrice?: number,
): Promise<number> {
  // Hourly first: it fixes the scale, and is reused as the h1 series.
  const hourly = await fetchCandles(mint, '1h');
  if (hourly.length === 0) return 0;

  const scale =
    anchorPrice !== undefined && anchorPrice > 0
      ? scaleFromAnchor(hourly, anchorPrice)
      : scaleFromOverlap(await readCandles(client, mint, 'h1', 1000), hourly);
  if (scale === null) return 0;

  const priceOf = (value: number): bigint => BigInt(Math.max(1, Math.round(value * scale)));

  let added = 0;
  for (const source of TF_INTERVAL) {
    const candles = source.interval === '1h' ? hourly : await fetchCandles(mint, source.interval);
    if (candles.length === 0) continue;

    const mine = await readCandles(client, mint, source.timeframe, 5000);
    const have = new Set(mine.map((c) => c.openTime));

    const writes = candles
      .filter((g) => !have.has(g.t))
      .map((g) => ({
        openTime: g.t,
        open: priceOf(g.o),
        high: priceOf(g.h),
        low: priceOf(g.l),
        close: priceOf(g.c),
        // pump.fun's volume is in its own units and does not convert onto the
        // lamport axis, so it is left off rather than faked; price is what is
        // scaled to match, and price is what the chart is read from.
        volumeLamports: 0n,
        // A real candle, not a flat gap-fill, so the chart draws it as history.
        trades: 1,
      }));
    if (writes.length === 0) continue;
    await writeCandles(client, mint, source.timeframe, writes);
    added += writes.length;
  }

  return added;
}
