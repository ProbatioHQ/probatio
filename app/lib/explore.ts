import 'server-only';

/**
 * What is actually moving, which this database cannot answer on its own.
 *
 * There are tens of thousands of launches indexed here and price history for
 * only the couple of hundred anybody has opened, because history is kept for
 * tokens people look at and retention prunes the rest. So there is no series to
 * compute a change from, and "movers" has to be assembled from the two services
 * the site already depends on.
 *
 * pump.fun's own listing gives the candidates and everything a card needs in
 * one call: art, creator, market cap, the launcher's links. Its sorts are
 * market cap, last trade, created and reply count; there is no volume or change
 * sort, which is why this ranks rather than just re-printing a list. DEX
 * Screener, already used for search, supplies the hour's change and the day's
 * volume for those mints, thirty at a time.
 *
 * Ranked on the hour's move, but only for tokens with volume behind it. Sorting
 * purely on percentage puts a dead token that someone bought twice at the top
 * of the page, which is the opposite of what a page called Movers is for.
 *
 * This is the one screen whose ordering is somebody else's opinion. It is
 * labelled as such where it is shown. Fills on these tokens are still quoted
 * from chain reserves like everywhere else; nothing here touches the record.
 */

const PUMP_LIST = 'https://frontend-api-v3.pump.fun/coins';
const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';
const CANDLES = 'https://swap-api.pump.fun/v1/coins';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** How long a whole page of movers stays good for. */
const CACHE_MS = 30_000;
/** Sparklines move slower than the ranking and cost a call each. */
const SPARK_CACHE_MS = 5 * 60_000;
/** Candidates to consider before ranking. */
const CANDIDATES = 60;
/** DEX Screener takes thirty addresses per request. */
const DEX_BATCH = 30;
/** Sparkline fetches in flight at once. */
const SPARK_CONCURRENCY = 6;

/**
 * Volume a token needs before its percentage means anything.
 *
 * Without a floor the board fills with tokens that moved 400% on eleven dollars
 * of trading, which is true and useless. In dollars over the last day.
 */
const MIN_VOLUME_USD = 500;

export interface Mover {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly image: string | null;
  readonly creator: string;
  readonly createdAt: number;
  readonly marketCapUsd: number;
  /** The hour's move, or null when DEX Screener has no pair for it yet. */
  readonly changeH1: number | null;
  readonly volumeH24: number;
  readonly description: string | null;
  readonly twitter: string | null;
  readonly website: string | null;
  readonly complete: boolean;
  /** Closes over the last few hours, for the line drawn on the card. */
  readonly spark: readonly number[];
}

interface Cached<T> {
  at: number;
  value: T;
}

/*
 * Shared across bundles, for the reason written out in lib/health.ts: this is
 * reached from a route and from the page, and a per-bundle copy means each side
 * keeps its own and the outside services are asked twice for the same answer.
 */
const CACHE_KEY = Symbol.for('probatio.explore-cache');
const SPARK_KEY = Symbol.for('probatio.explore-sparks');

function store<T>(key: symbol): Map<string, Cached<T>> {
  const global = globalThis as typeof globalThis & Record<symbol, unknown>;
  global[key] ??= new Map<string, Cached<T>>();
  return global[key] as Map<string, Cached<T>>;
}

interface PumpCoin {
  mint?: unknown;
  name?: unknown;
  symbol?: unknown;
  image_uri?: unknown;
  creator?: unknown;
  created_timestamp?: unknown;
  usd_market_cap?: unknown;
  description?: unknown;
  twitter?: unknown;
  website?: unknown;
  complete?: unknown;
}

const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** https only, because these end up in an href a reader clicks. */
const link = (value: unknown): string | null => {
  const raw = text(value, 400);
  return raw && /^https:\/\//i.test(raw) ? raw : null;
};

async function candidates(): Promise<PumpCoin[]> {
  const url = `${PUMP_LIST}?offset=0&limit=${CANDIDATES}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`;
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as PumpCoin[]) : [];
}

/** The hour's change and the day's volume, keyed by mint. */
async function marketStats(
  mints: readonly string[],
): Promise<Map<string, { changeH1: number | null; volumeH24: number }>> {
  const stats = new Map<string, { changeH1: number | null; volumeH24: number }>();

  const batches: string[][] = [];
  for (let i = 0; i < mints.length; i += DEX_BATCH) batches.push([...mints.slice(i, i + DEX_BATCH)]);

  await Promise.all(
    batches.map(async (batch) => {
      try {
        const response = await fetch(`${DEXSCREENER}/${batch.join(',')}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) return;
        const body = (await response.json()) as { pairs?: unknown[] } | null;
        for (const raw of body?.pairs ?? []) {
          const pair = raw as {
            baseToken?: { address?: unknown };
            priceChange?: { h1?: unknown };
            volume?: { h24?: unknown };
          };
          const mint = typeof pair.baseToken?.address === 'string' ? pair.baseToken.address : null;
          if (!mint) continue;

          const volume = num(pair.volume?.h24);
          const change = pair.priceChange?.h1 === undefined ? null : num(pair.priceChange.h1);

          // A token can have several pairs. Keep the one with the most trading:
          // the deepest pair is the one whose price actually moved the market,
          // and a dust pair's percentage is noise. Same reasoning as pricing a
          // graduated token from its deepest pool rather than the first found.
          const held = stats.get(mint);
          if (!held || volume > held.volumeH24) stats.set(mint, { changeH1: change, volumeH24: volume });
        }
      } catch {
        // A batch that fails costs those tokens their ranking, not the page.
      }
    }),
  );

  return stats;
}

/**
 * A few dozen closes for the line on a card.
 *
 * Fetched here rather than in the browser because six visible cards would be
 * six requests to somebody else's service on every render, and a scrolled page
 * many more. Cached for longer than the ranking, since the shape of the last
 * few hours does not change in thirty seconds.
 */
async function sparkline(mint: string): Promise<number[]> {
  const cache = store<number[]>(SPARK_KEY);
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < SPARK_CACHE_MS) return hit.value;

  try {
    /*
     * One minute buckets over the last hour, matching the number beside them.
     *
     * Five-minute buckets gave a token twenty minutes old four points, which is
     * a straight line pretending to be a chart, and it covered a different span
     * from the hourly change the card is ranked on. The line and the percentage
     * now describe the same hour.
     */
    const url = `${CANDLES}/${mint}/candles?interval=1m&limit=60&currency=SOL`;
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://pump.fun' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return [];

    // `close`, and it arrives as a decimal string. The short names this first
    // read for (`c`) belong to no version of this endpoint: every candle came
    // back as zero, was filtered out, and every card drew an empty line.
    const closes = body
      .map((candle) => num((candle as Record<string, unknown>)['close']))
      .filter((value) => Number.isFinite(value) && value > 0);

    cache.set(mint, { at: Date.now(), value: closes });
    return closes;
  } catch {
    return [];
  }
}

async function withSparklines(movers: Omit<Mover, 'spark'>[]): Promise<Mover[]> {
  const out: Mover[] = new Array(movers.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(SPARK_CONCURRENCY, movers.length) }, async () => {
    while (cursor < movers.length) {
      const index = cursor;
      cursor += 1;
      const mover = movers[index];
      if (!mover) continue;
      out[index] = { ...mover, spark: await sparkline(mover.mint) };
    }
  });
  await Promise.all(workers);

  return out.filter(Boolean);
}

/** The board. Cached, so a room full of readers costs one round of calls. */
export async function movers(limit = 24): Promise<Mover[]> {
  const cache = store<Mover[]>(CACHE_KEY);
  const hit = cache.get('board');
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value.slice(0, limit);

  const coins = await candidates();
  const usable = coins
    .map((coin) => ({
      mint: text(coin.mint, 64) ?? '',
      name: text(coin.name, 120) ?? '',
      symbol: text(coin.symbol, 40) ?? '',
      image: text(coin.image_uri, 400),
      creator: text(coin.creator, 64) ?? '',
      createdAt: Math.floor(num(coin.created_timestamp) / 1000),
      marketCapUsd: num(coin.usd_market_cap),
      description: text(coin.description, 300),
      twitter: link(coin.twitter),
      website: link(coin.website),
      complete: coin.complete === true,
    }))
    .filter((coin) => coin.mint !== '' && coin.name !== '');

  if (usable.length === 0) return hit?.value.slice(0, limit) ?? [];

  const stats = await marketStats(usable.map((coin) => coin.mint));

  const ranked = usable
    .map((coin) => {
      const stat = stats.get(coin.mint);
      return {
        ...coin,
        changeH1: stat?.changeH1 ?? null,
        volumeH24: stat?.volumeH24 ?? 0,
      };
    })
    // Real trading behind the percentage, or the board fills with tokens that
    // moved hundreds of percent on a few dollars.
    .filter((coin) => coin.volumeH24 >= MIN_VOLUME_USD && coin.changeH1 !== null)
    .sort((a, b) => (b.changeH1 ?? 0) - (a.changeH1 ?? 0))
    .slice(0, limit);

  const board = await withSparklines(ranked);

  // Only cached when there is something to cache. An empty result from a
  // service having a bad minute should not be served for the next thirty
  // seconds as though it were the answer.
  if (board.length > 0) cache.set('board', { at: Date.now(), value: board });
  return board;
}
