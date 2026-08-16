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
 * Two things make the full history awkward, and this handles both. First, an
 * old token's launch is only in the *daily* series — it traded too little early
 * on for the index to keep hourly candles that far back — so the daily series is
 * pulled and stored as its own `d1` timeframe, which the day/week/month views
 * read. Second, a graduated token's early history lives on its *bonding-curve*
 * pool (created at launch, drained to zero now), not the deep pool a chart
 * follows today, so every pool is queried and merged, the deep one winning where
 * they overlap.
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

interface GeckoPool {
  readonly addr: string;
  readonly liq: number;
  readonly createdAt: string;
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

/** Every pool the index knows for this token, with its liquidity and age. */
async function listPools(mint: string): Promise<GeckoPool[]> {
  const body = (await fetchJson(`${BASE}/tokens/${mint}/pools`)) as
    | {
        data?: Array<{
          id?: unknown;
          attributes?: { reserve_in_usd?: unknown; pool_created_at?: unknown };
        }>;
      }
    | null;
  const pools = body?.data;
  if (!Array.isArray(pools)) return [];
  const out: GeckoPool[] = [];
  for (const p of pools) {
    const addr = String(p?.id ?? '').replace(/^solana_/, '');
    if (!addr) continue;
    out.push({
      addr,
      liq: Number(p?.attributes?.reserve_in_usd ?? 0),
      createdAt: String(p?.attributes?.pool_created_at ?? ''),
    });
  }
  return out;
}

async function fetchOhlcv(
  pool: string,
  unit: 'hour' | 'minute' | 'day',
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

/*
 * Which timeframes to pull, and from where.
 *
 * `d1` carries the deep past (the only series that reaches an old token's launch)
 * and `h1` the recent detail, both merged across every pool so a graduated
 * token's bonding-curve history is included. `m15` is recent detail only, so it
 * is taken from the deep pool alone — no other pool has fifteen-minute candles
 * from far enough back to matter, and querying them all would just spend calls.
 */
const TF_SOURCE: ReadonlyArray<{
  timeframe: string;
  unit: 'hour' | 'minute' | 'day';
  aggregate: number;
  allPools: boolean;
}> = [
  { timeframe: 'h1', unit: 'hour', aggregate: 1, allPools: true },
  { timeframe: 'd1', unit: 'day', aggregate: 1, allPools: true },
  { timeframe: 'm15', unit: 'minute', aggregate: 15, allPools: false },
];

/** The fewest overlapping candles that make the scale trustworthy. */
const MIN_OVERLAP = 12;

/** The store's price scale over the index's, from the live price if given. */
function scaleFromAnchor(deepH1: GeckoCandle[], anchorPrice: number): number | null {
  // The most recent index candle is "now", and the live price is "now" on the
  // store's scale, so their ratio maps the whole index history onto that scale.
  let latest: GeckoCandle | null = null;
  for (const g of deepH1) {
    if (g.c > 0 && (latest === null || g.t > latest.t)) latest = g;
  }
  if (latest === null) return null;
  const scale = anchorPrice / latest.c;
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** The same scale, from where the walk and the index overlap. */
function scaleFromOverlap(mineH1: readonly StoredCandle[], deepH1: GeckoCandle[]): number | null {
  const mineByTime = new Map(
    mineH1.filter((c) => c.trades > 0).map((c) => [c.openTime, Number(c.close)]),
  );
  const ratios: number[] = [];
  for (const g of deepH1) {
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
  const pools = await listPools(mint);
  if (pools.length === 0) return 0;

  // The deep pool for the recent, reliable end; the earliest-created for the
  // launch-to-graduation past that a graduated token's drained bonding-curve
  // pool still holds and no other pool has.
  const deepest = pools.reduce((a, b) => (b.liq > a.liq ? b : a));
  const earliest = pools.reduce((a, b) => (b.createdAt !== '' && b.createdAt < a.createdAt ? b : a));
  const selected = earliest.addr === deepest.addr ? [deepest] : [deepest, earliest];

  // Anchor the scale on the deep pool's hourly, the most current and reliable.
  const deepH1 = await fetchOhlcv(deepest.addr, 'hour', 1);
  if (deepH1.length === 0) return 0;
  const scale =
    anchorPrice !== undefined && anchorPrice > 0
      ? scaleFromAnchor(deepH1, anchorPrice)
      : scaleFromOverlap(await readCandles(client, mint, 'h1', 1000), deepH1);
  if (scale === null) return 0;

  const priceOf = (value: number): bigint => BigInt(Math.max(1, Math.round(value * scale)));

  let added = 0;
  for (const source of TF_SOURCE) {
    const query = source.allPools ? selected : [deepest];
    // Merge this timeframe across the queried pools into one series. Earliest
    // pool first, deep pool last, so the deep pool wins any overlapping bucket.
    const merged = new Map<number, GeckoCandle>();
    for (const pool of [...query].reverse()) {
      const reuseDeepH1 =
        pool.addr === deepest.addr && source.unit === 'hour' && source.aggregate === 1;
      const candles = reuseDeepH1 ? deepH1 : await fetchOhlcv(pool.addr, source.unit, source.aggregate);
      for (const g of candles) merged.set(g.t, g);
    }
    if (merged.size === 0) continue;

    const mine = await readCandles(client, mint, source.timeframe, 5000);
    // Fill any bucket the store does not already have, and rewrite none — the
    // walk's own candles, at the live scale, always win where it reached.
    const have = new Set(mine.map((c) => c.openTime));

    const writes = [...merged.values()]
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
