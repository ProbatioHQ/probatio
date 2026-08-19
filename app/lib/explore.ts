import 'server-only';
import { cacheImages } from './token-images';

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

/**
 * How long the ranking stays good for.
 *
 * Two minutes, because building it is now sixteen calls to pump.fun and about
 * twenty-seven to DEX Screener. An hour's move does not change enough in two
 * minutes to be worth fifty requests to other people's services, and this
 * server is already asking pump.fun for a chart every twenty seconds.
 */
const CACHE_MS = 120_000;
/** Sparklines move slower than the ranking and cost a call each. */
const SPARK_CACHE_MS = 5 * 60_000;
/**
 * The pool, and why it is not the recently-traded one.
 *
 * The first version took the sixty most recently traded coins and ranked those.
 * That pool has a median age of five hours, so it was the terminal's new lane
 * wearing different clothes, and the board filled with tokens up 37,000% on a
 * few hundred dollars because a percentage computed over a token's first hour
 * of existence is arithmetic rather than information.
 *
 * Sorted by market cap and paged deep instead: a pool with a median age of
 * about five months and real order books behind it. Ranking that by the hour's
 * move gives things like a two-million-dollar token up 24% on five million of
 * volume, which is what somebody opening a page called Movers came to see.
 *
 * Sixteen pages of fifty, which was eight. Eight was sized against the volume
 * floor alone, and once a token also has to have actually moved it was nowhere
 * near enough: of the 214 eligible tokens it found, 101 had moved a percent, so
 * the board ran out before its second page. A thousand candidates yields 338
 * eligible and enough past the floors to fill the three pages. Sixteen rather
 * than twenty because the market cap floor below already cuts in around the
 * seven hundredth token, so the pages past that are fetched and discarded.
 *
 * Deeper is also better material. The largest few hundred tokens by market cap
 * are the ones that move least, so the pages this reaches now are where an hour
 * actually shows up.
 */
const CANDIDATE_PAGES = 16;
const PAGE_SIZE = 50;
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

/**
 * How far a token has to have moved to be called a mover, in percent.
 *
 * Anything under this rounds to "+0%" on the card, which is not a fact anybody
 * came to the page for. Measured over 338 eligible tokens: 176 clear one
 * percent, which is just under the three pages of sixty this board shows, so
 * the floor is what fills the board rather than what empties it.
 */
const MIN_ABS_CHANGE = 1;

/**
 * How much a token has to be worth before its hour is worth ranking.
 *
 * Paging deeper found real movers and also found the thing the market-cap pool
 * was chosen to avoid: a token up 7,858% in an hour. That one was not the usual
 * dust either, it had a hundred thousand dollars of volume behind it, so no
 * volume floor removes it. What it had was a $175k market cap, meaning its
 * price an hour earlier implied a token worth about two thousand dollars. A
 * percentage measured from nearly nothing is arithmetic, not information, and
 * it sat at the top of the board making every real move look like noise.
 *
 * Measured across the same pool: at $200k the largest move on the board falls
 * from 7,858% to 70%, and 152 tokens still clear the change floor. It is the
 * launch artifacts that go, not the movers.
 */
const MIN_MARKET_CAP_USD = 200_000;

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

/** One page of the market-cap listing. An empty array means it did not answer. */
async function fetchPage(offset: number): Promise<PumpCoin[]> {
  const url = `${PUMP_LIST}?offset=${offset}&limit=${PAGE_SIZE}&sort=market_cap&order=DESC&includeNsfw=false`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    return Array.isArray(body) ? (body as PumpCoin[]) : [];
  } catch {
    // One page missing costs its fifty candidates, not the board.
    return [];
  }
}

/**
 * Deduped: paging a list that is being reordered under you can hand back the
 * same coin on two pages, and a board with a token on it twice looks broken.
 */
function dedupe(coins: readonly PumpCoin[]): PumpCoin[] {
  const seen = new Set<string>();
  const all: PumpCoin[] = [];
  for (const coin of coins) {
    const mint = typeof coin.mint === 'string' ? coin.mint : '';
    if (mint === '' || seen.has(mint)) continue;
    seen.add(mint);
    all.push(coin);
  }
  return all;
}

/**
 * Read `count` pages of the listing, a few at a time.
 *
 * All of them at once was fine at eight and is not at twenty: that is twenty
 * simultaneous requests to a service this page cannot do without, to build
 * something one reader is waiting on. Four at a time keeps the burst small and
 * costs a few hundred milliseconds against a result cached for two minutes.
 */
const PAGE_CONCURRENCY = 4;

async function fetchPages(count: number): Promise<PumpCoin[]> {
  const coins: PumpCoin[] = [];
  for (let i = 0; i < count; i += PAGE_CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(PAGE_CONCURRENCY, count - i) }, (_, n) =>
        fetchPage((i + n) * PAGE_SIZE),
      ),
    );
    coins.push(...batch.flat());
  }
  return coins;
}

async function candidates(): Promise<PumpCoin[]> {
  return dedupe(await fetchPages(CANDIDATE_PAGES));
}

/**
 * The mints worth keeping a chart for, biggest first.
 *
 * The board reads eight pages at once because it is answering a request and the
 * page is waiting. This reads many more than that for a background job nobody is
 * waiting on, so it goes four pages at a time: the same listing serves the
 * board, and being rate-limited to fill a cache would take the visible feature
 * down with it.
 *
 * Cached for ten minutes. Which tokens are the largest few hundred changes over
 * days, and the caller asks every time it warms one.
 */
const WARM_LIST_KEY = Symbol.for('probatio.explore-warmlist');
const WARM_LIST_CACHE_MS = 10 * 60_000;
const WARM_PAGE_CONCURRENCY = 4;

export async function topMints(limit: number): Promise<string[]> {
  const cache = store<string[]>(WARM_LIST_KEY);
  const key = `top:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < WARM_LIST_CACHE_MS) return hit.value;

  const pageCount = Math.ceil(limit / PAGE_SIZE);
  const coins: PumpCoin[] = [];
  for (let i = 0; i < pageCount; i += WARM_PAGE_CONCURRENCY) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(WARM_PAGE_CONCURRENCY, pageCount - i) }, (_, n) =>
        fetchPage((i + n) * PAGE_SIZE),
      ),
    );
    coins.push(...batch.flat());
  }

  const mints = dedupe(coins)
    .map((coin) => (typeof coin.mint === 'string' ? coin.mint : ''))
    .filter((mint) => mint !== '')
    .slice(0, limit);

  // A failed sweep is not cached, so the next tick retries rather than living
  // with an empty list for ten minutes.
  if (mints.length > 0) cache.set(key, { at: Date.now(), value: mints });
  return mints;
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
          // DEX Screener refuses some clients on User-Agent alone: a plain
          // library default gets a 403 where a browser's gets a 200. Sent
          // explicitly rather than left to whatever the runtime volunteers.
          headers: { 'User-Agent': UA, Accept: 'application/json' },
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

export interface Board {
  readonly movers: Mover[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
}

/** The ranking, without sparklines. Cached, so readers share one round of calls. */
async function ranking(): Promise<Omit<Mover, 'spark'>[]> {
  const cache = store<Omit<Mover, 'spark'>[]>(CACHE_KEY);
  const hit = cache.get('board');
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

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

  if (usable.length === 0) return hit?.value ?? [];

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
    .filter(
      (coin) =>
        coin.volumeH24 >= MIN_VOLUME_USD &&
        coin.marketCapUsd >= MIN_MARKET_CAP_USD &&
        coin.changeH1 !== null,
    )
    /*
     * A token that has not moved is not a mover.
     *
     * Sorting by the hour's gain and taking the first hundred and eighty fills
     * the board whether or not there are a hundred and eighty tokens worth
     * showing, and measured against the live pool there never are: of 214
     * eligible tokens only 19 had moved five percent, so the sixtieth card was
     * already +0.68% and everything after it rounded to zero. Three pages of
     * "+0%" is a board reporting that nothing happened, at length.
     */
    .filter((coin) => Math.abs(coin.changeH1 ?? 0) >= MIN_ABS_CHANGE)
    /*
     * Ranked by how far it moved, not by which way.
     *
     * A board called Movers that only counts upwards is half a board, and the
     * half it drops is the half people most want warning about: in the same
     * measurement the biggest fall was 14.5% while the sixtieth gain was under
     * one. Losses are shown in the loss colour and read as clearly as gains.
     */
    .sort((a, b) => Math.abs(b.changeH1 ?? 0) - Math.abs(a.changeH1 ?? 0));

  /*
   * Hand the pictures to the token pages before anybody clicks one.
   *
   * The board gets its art from pump.fun's listing; a token page reads this
   * site's own metadata table, which is filled for tokens the launch feed saw.
   * Everything here is ranked by market cap and therefore months old, so none
   * of it was ever in that feed, and clicking a card with a picture on it
   * opened a page with a placeholder. Recorded here, in the background, so the
   * first visit already has it rather than the second.
   */
  cacheImages(
    ranked.map((coin) => ({
      mint: coin.mint,
      name: coin.name,
      symbol: coin.symbol,
      image: coin.image,
    })),
  );

  // Only cached when there is something to cache. An empty result from a
  // service having a bad minute should not be served for the next minute as
  // though it were the answer.
  if (ranked.length > 0) cache.set('board', { at: Date.now(), value: ranked });
  return ranked.length > 0 ? ranked : (hit?.value ?? []);
}

/**
 * One page of the board.
 *
 * Sparklines are fetched for the page being read and no further. Drawing a line
 * on every one of a hundred and eighty cards would be a hundred and eighty
 * requests to somebody else's candle service before the first page could be
 * shown, to draw a hundred and twenty lines nobody has scrolled to yet. A page
 * is sixty, they run six at a time, and each one is cached for five minutes, so
 * turning back to a page already read costs nothing.
 */
export async function movers(page = 1, perPage = 60, maxPages = 3): Promise<Board> {
  const ranked = await ranking();
  const pages = Math.max(1, Math.min(maxPages, Math.ceil(ranked.length / perPage)));
  const current = Math.min(Math.max(1, Math.trunc(page)), pages);

  const slice = ranked.slice((current - 1) * perPage, current * perPage);
  return {
    movers: await withSparklines(slice),
    page: current,
    pages,
    total: Math.min(ranked.length, pages * perPage),
  };
}
