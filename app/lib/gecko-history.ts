import 'server-only';
import { readCandles, writeCandles, type Client, type StoredCandle } from '@probatio/db';

/**
 * Deep chart history from an index, for the part of a token's life that reading
 * every trade off chain cannot reach.
 *
 * A token doing thousands of swaps a day buries its first days under tens of
 * thousands of transactions. Walking each one to reconstruct those candles is
 * both slow and, past a point, impractical: the walk reaches a week back and
 * stops short of launch, leaving the start of the chart missing. GeckoTerminal
 * already indexes every pool's OHLCV from creation, in one free, keyless call,
 * which is how a pump.fun-style chart shows a full history cheaply.
 *
 * This is display only. Trades still fill against live on-chain reserves and the
 * verifiable trade record is derived from chain alone; nothing here touches
 * either. It fills the visual past of a chart with what an index already knows,
 * scaled onto the same axis the live price uses so the two meet without a step.
 */

const BASE = 'https://api.geckoterminal.com/api/v2/networks/solana';

interface GeckoCandle {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** The pool with the most liquidity, which is the one a chart should follow. */
async function deepestPool(mint: string): Promise<string | null> {
  const body = (await fetchJson(`${BASE}/tokens/${mint}/pools`)) as
    | { data?: Array<{ id?: unknown; attributes?: { reserve_in_usd?: unknown } }> }
    | null;
  const pools = body?.data;
  if (!Array.isArray(pools) || pools.length === 0) return null;
  let best: { addr: string; liq: number } | null = null;
  for (const p of pools) {
    const addr = String(p?.id ?? '').replace(/^solana_/, '');
    const liq = Number(p?.attributes?.reserve_in_usd ?? 0);
    if (!addr) continue;
    if (best === null || liq > best.liq) best = { addr, liq };
  }
  return best?.addr ?? null;
}

async function fetchOhlcv(
  pool: string,
  unit: 'hour' | 'minute',
  aggregate: number,
): Promise<GeckoCandle[]> {
  const query = new URLSearchParams({ aggregate: String(aggregate), limit: '1000' });
  const body = (await fetchJson(`${BASE}/pools/${pool}/ohlcv/${unit}?${query.toString()}`)) as
    | { data?: { attributes?: { ohlcv_list?: number[][] } } }
    | null;
  const list = body?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => ({ t: x[0]!, o: x[1]!, h: x[2]!, l: x[3]!, c: x[4]!, v: x[5]! }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0);
}

/** Median, robust to the few noisy candles at the sparse edge of a walk. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// GeckoTerminal reports a price; the candle store holds it on an internal scale
// (a fixed-point price in the pool's quote). The ratio between the two is
// constant enough across the overlap that its median lines the index's history
// up with the walk's — the sparse-edge candles that disagree are outvoted.
const TF_SOURCE: ReadonlyArray<{ timeframe: string; unit: 'hour' | 'minute'; aggregate: number }> = [
  { timeframe: 'h1', unit: 'hour', aggregate: 1 },
  { timeframe: 'm15', unit: 'minute', aggregate: 15 },
];

/** The fewest overlapping candles that make the scale trustworthy. */
const MIN_OVERLAP = 12;

/** The store's price scale over the index's, from the live price if given. */
function scaleFromAnchor(geckoH1: GeckoCandle[], anchorPrice: number): number | null {
  // The most recent index candle is "now", and the live price is "now" on the
  // store's scale, so their ratio maps the whole index history onto that scale.
  let latest: GeckoCandle | null = null;
  for (const g of geckoH1) {
    if (g.c > 0 && (latest === null || g.t > latest.t)) latest = g;
  }
  if (latest === null) return null;
  const scale = anchorPrice / latest.c;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** The same scale, from where the walk and the index overlap. */
function scaleFromOverlap(mineH1: readonly StoredCandle[], geckoH1: GeckoCandle[]): number | null {
  const mineByTime = new Map(
    mineH1.filter((c) => c.trades > 0).map((c) => [c.openTime, Number(c.close)]),
  );
  const ratios: number[] = [];
  for (const g of geckoH1) {
    const mine = mineByTime.get(g.t);
    if (mine !== undefined && g.c > 0) ratios.push(mine / g.c);
  }
  if (ratios.length < MIN_OVERLAP) return null;
  const scale = median(ratios);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/**
 * Fill a chart's history from the index, scaled onto the store's axis.
 *
 * Given a live price (the current pool price on the store's scale), it anchors
 * to that and can run before the walk — the whole chart is on screen in seconds
 * rather than after the minutes a walk takes. Without one it falls back to the
 * walk/index overlap, so it still works when called afterwards. Either way it
 * only fills buckets the store does not already have, and rewrites none of them.
 * Best-effort: a missing pool or throttled index just leaves the chart as-is.
 * Returns how many candles it added.
 */
export async function spliceGeckoHistory(
  client: Client,
  mint: string,
  anchorPrice?: number,
): Promise<number> {
  const pool = await deepestPool(mint);
  if (pool === null) return 0;

  const geckoH1 = await fetchOhlcv(pool, 'hour', 1);
  if (geckoH1.length === 0) return 0;

  const scale =
    anchorPrice !== undefined && anchorPrice > 0
      ? scaleFromAnchor(geckoH1, anchorPrice)
      : scaleFromOverlap(await readCandles(client, mint, 'h1', 1000), geckoH1);
  if (scale === null) return 0;

  const priceOf = (value: number): bigint => BigInt(Math.max(1, Math.round(value * scale)));

  let added = 0;
  for (const source of TF_SOURCE) {
    const gecko =
      source.unit === 'hour' && source.aggregate === 1
        ? geckoH1
        : await fetchOhlcv(pool, source.unit, source.aggregate);
    if (gecko.length === 0) continue;

    const mine = await readCandles(client, mint, source.timeframe, 5000);
    // Fill any bucket the walk did not produce, not merely everything older than
    // its oldest. The walk's history is not contiguous — a lone bonding-curve
    // candle can sit at launch with a gap of days between it and where the pool
    // walk reached — so "older than the oldest" would leave that gap empty. A
    // per-bucket check fills every hole the walk left and rewrites none of it.
    const have = new Set(mine.map((c) => c.openTime));

    const writes = gecko
      .filter((g) => !have.has(g.t))
      .map((g) => ({
        openTime: g.t,
        open: priceOf(g.o),
        high: priceOf(g.h),
        low: priceOf(g.l),
        close: priceOf(g.c),
        // Volume is in the index's own units and does not convert onto the
        // lamport axis, so it is left off these old candles rather than faked.
        // The one that carries the chart is price, and that is scaled to match.
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
