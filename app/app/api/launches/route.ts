import {
  bondedLaunches,
  bondingLaunches,
  creatorLaunchCounts,
  newLaunches,
  searchLaunches,
  type LaunchWithCurve,
} from '@probatio/db';
import { PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { marketCapLamports, priceFromReserves } from '@probatio/candles';
import { capsFromChain, capsFromIndex } from '@/lib/curve-cap';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { DEFAULT_FILTERS, matchesFilters, type Filters } from '@/lib/feed-filters';
import { cacheImages, knownImages, resolveLaunchImages } from '@/lib/token-images';
import { solUsd } from '@/lib/sol-price';
import { resolveTokenName } from '@/lib/token-name';
import { searchExternalTokens } from '@/lib/token-search';

/**
 * The launch feed, in three lanes, and search over it.
 *
 * Open to anyone. Discovery is what a visitor sees before they have a wallet,
 * and putting it behind a sign-in would mean the first thing a new arrival
 * meets is a login wall in front of an empty room.
 *
 * Three lanes rather than one list because that is how these are actually
 * traded: what just launched, what is close to graduating, and what already
 * has. Which lane a token is in comes from its bonding curve account, not from
 * its age — a token can sit at 2% for a week or graduate in ninety seconds.
 */

const MAX_LIMIT = 100;

/** A base58 mint address, the thing someone pastes to reach a token directly. */
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * The floor for "about to bond".
 *
 * Half the curve sold. Without a floor this lane is the new lane in a different
 * order, and a token at 0.4% is not about to do anything.
 */
const BONDING_FLOOR_BPS = 5_000;

/**
 * What a token is worth, from the reserves already read.
 *
 * pump.fun mints a fixed supply, which is what turns a price into the market
 * cap traders actually quote at each other. Null rather than zero when the
 * curve has not been read: an unknown value and a worthless token are not the
 * same thing and must not render the same.
 */
/**
 * What a curve is worth before anybody has traded it.
 *
 * Every pump.fun launch opens at the same place: 30 SOL of virtual SOL reserve
 * against 1,073,000,000,000,000 base units of virtual token reserve. Buying
 * only ever moves the price up from there, so this is a hard floor that no
 * live curve can be under.
 */
const OPENING_VIRTUAL_SOL = 30_000_000_000n;
const OPENING_VIRTUAL_TOKENS = 1_073_000_000_000_000n;
const OPENING_MARKET_CAP = marketCapLamports(
  priceFromReserves(OPENING_VIRTUAL_SOL, OPENING_VIRTUAL_TOKENS),
  PUMPFUN_TOKEN_TOTAL_SUPPLY,
);

function marketCapOf(launch: LaunchWithCurve): string | null {
  const curve = launch.curve;
  if (!curve?.virtualSolReserves || !curve.virtualTokenReserves) return null;
  if (curve.virtualTokenReserves <= 0n) return null;

  const price = priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves);
  const cap = marketCapLamports(price, PUMPFUN_TOKEN_TOTAL_SUPPLY);

  /*
   * A curve cannot be worth less than the day it opened.
   *
   * Two tokens in the feed read 99.86% and 95.98% bonded with market caps of
   * thirteen and twenty-four dollars, against roughly twenty-seven thousand for
   * their neighbours at the same progress. Progress is read from the real token
   * reserve and the cap from the virtual pair, so a row written while a curve
   * was migrating can hold a nearly-sold reserve alongside a virtual pair that
   * has already been zeroed out, and the two then describe different worlds.
   *
   * Rather than guess which half is right, the impossible half is discarded:
   * under the opening cap is not a cheap token, it is a bad read. Reported as
   * unknown so the caller falls back to what the chain said, and the next curve
   * read corrects it.
   */
  if (cap < OPENING_MARKET_CAP) return null;
  return cap.toString();
}

function shape(
  launch: LaunchWithCurve,
  image: string | null,
  creatorLaunches: number,
  capFromChain?: string | null,
) {
  return {
    mint: launch.mint,
    name: launch.name,
    symbol: launch.symbol,
    creator: launch.creator,
    launchedAt: launch.launchedAt,
    image,
    // Null means nothing has read this curve yet, which is normal for a token
    // that launched seconds ago and is different from a curve at zero.
    progressBps: launch.curve?.progressBps ?? null,
    // The curve if the feed has read one, otherwise whatever the chain said
    // when this page was built. Only null when neither knows.
    marketCap: marketCapOf(launch) ?? capFromChain ?? null,
    complete: launch.curve?.complete ?? false,
    // A floor on how many tokens this wallet has launched, counted from what
    // this feed has seen. One is an unknown; forty is a pattern.
    creatorLaunches,
  };
}

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';

  const requested = Number(url.searchParams.get('limit') ?? '30');
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : 30;

  const client = await db();

  // A search is a search. Splitting results across three lanes would hide the
  // token somebody pasted an address for in whichever column it happened to
  // belong to.
  if (query) {
    const found = await searchLaunches(client, query, limit);

    // A pasted address the feed never caught still resolves. The token page
    // reads any mint from chain, so search must reach it too rather than stop
    // at what the feed happened to see — that is the whole point of search over
    // and above the feed. Only when the local search found nothing and the
    // query is an address, so a name search still costs one query, not a chain
    // read, and a token already in the feed is served from the feed.
    if (found.length === 0 && MINT_PATTERN.test(query)) {
      const named = await resolveTokenName(query);
      resolveLaunchImages([query]);
      const image = (await knownImages([query])).get(query) ?? null;
      const pastedCap = (await capsFromChain([query])).get(query) ?? null;
      return Response.json({
        query,
        solUsd: await solUsd(),
        results: [
          shape(
            {
              mint: query,
              name: named.name,
              symbol: named.symbol ?? named.name,
              creator: '',
              bondingCurve: '',
              uri: '',
              launchedAt: 0,
              slot: null,
              firstSeenAt: 0,
              curve: null,
            },
            image,
            1,
            pastedCap,
          ),
        ],
      });
    }

    // A name reaches past the feed: an outside index turns the word into mints
    // the feed never saw, which is the whole reason search sits above the feed.
    // Discovery only — the fill still reads chain, never this. A token already
    // in the feed is kept from there, where its curve is fresher, and its
    // duplicate from the index is dropped. Skipped for an address query, which
    // is a mint, not a name.
    const localMints = new Set(found.map((launch) => launch.mint));
    const external = MINT_PATTERN.test(query)
      ? []
      : (await searchExternalTokens(query, limit)).filter((token) => !localMints.has(token.mint));

    // Keep the pictures the index found, so opening a result shows its logo at
    // once instead of resolving it from chain first.
    cacheImages(external);

    const images = await knownImages([...localMints, ...external.map((token) => token.mint)]);
    resolveLaunchImages([...localMints]);

    const searchCounts = await creatorLaunchCounts(
      client,
      found.map((launch) => launch.creator),
    );

    // The index reports market cap in dollars; the rest of the feed carries it
    // in lamports and converts to dollars for display with this same rate, so
    // the dollars are turned back into lamports here to travel the one path.
    const sol = await solUsd();
    const capLamports = (usd: number | null): string | null =>
      usd !== null && sol && sol > 0 ? Math.round((usd / sol) * 1e9).toString() : null;

    /*
     * A price for the local results.
     *
     * Search drops the curve it was given and rebuilds each row with `curve:
     * null`, so every token the feed itself knew about arrived without a market
     * cap and rendered as "n/a" — a column of unknowns beside index results
     * that all had a number. The curves are read from chain instead, in one
     * batched call for the whole page.
     */
    const searchCaps = await capsFromChain([
      ...found.map((launch) => launch.mint),
      ...external.map((token) => token.mint),
    ]);

    /*
     * Anything the curve could not price, asked of the index in one call: a
     * graduated token whose curve reserves are zeroed, and a token that never
     * came from pump.fun and has no curve to read.
     */
    const unpriced = [
      ...found.filter((launch) => !searchCaps.has(launch.mint)).map((launch) => launch.mint),
      ...external
        .filter((token) => token.marketCapUsd === null && !searchCaps.has(token.mint))
        .map((token) => token.mint),
    ];
    const indexCaps = await capsFromIndex(unpriced, sol);

    const results = [
      ...found.map((launch) =>
        shape(
          { ...launch, curve: null },
          images.get(launch.mint) ?? null,
          searchCounts.get(launch.creator) ?? 1,
          searchCaps.get(launch.mint) ?? indexCaps.get(launch.mint) ?? null,
        ),
      ),
      ...external.map((token) => ({
        ...shape(
          {
            mint: token.mint,
            name: token.name,
            symbol: token.symbol || token.name,
            creator: '',
            bondingCurve: '',
            uri: '',
            launchedAt: 0,
            slot: null,
            firstSeenAt: 0,
            curve: null,
          },
          images.get(token.mint) ?? token.image,
          1,
        ),
        // The index's dollars where it has them, the curve where it does not.
        marketCap:
          capLamports(token.marketCapUsd) ??
          searchCaps.get(token.mint) ??
          indexCaps.get(token.mint) ??
          null,
      })),
    ].slice(0, limit);

    return Response.json({ query, solUsd: sol, results });
  }

  /*
   * Filters are applied here, over a deep scan, not in the browser.
   *
   * They used to run only client-side, over the at most sixty rows a browser
   * happened to be holding, so a filter narrowed a window instead of searching
   * the feed. Two machines accumulate different sixties depending on how long
   * they have been open and what arrived over the stream, which is why one
   * showed sixty results and the other thirteen for the same filter, and why
   * neither was showing all of them.
   *
   * A filtered lane therefore reads far more candidates than it returns and
   * keeps the first `limit` that pass. Unfiltered lanes are untouched and cost
   * exactly what they did before.
   */
  const laneFilters = parseFilters(url.searchParams.get('filters'));
  const scanFor = (lane: LaneKey): number =>
    isFiltered(laneFilters[lane]) ? Math.min(limit * SCAN_MULTIPLE, MAX_SCAN) : limit;

  const [fresh, bonding, bonded] = await Promise.all([
    newLaunches(client, scanFor('new')),
    bondingLaunches(client, BONDING_FLOOR_BPS, scanFor('bonding')),
    bondedLaunches(client, scanFor('bonded')),
  ]);

  const mints = [...new Set([...fresh, ...bonding, ...bonded].map((launch) => launch.mint))];
  const images = await knownImages(mints);
  // Anything without a picture is queued rather than fetched inline. Waiting on
  // a stranger's IPFS gateway before returning a feed would make the slowest
  // token on the page decide how long the page takes.
  resolveLaunchImages(mints);

  const counts = await creatorLaunchCounts(
    client,
    [...fresh, ...bonding, ...bonded].map((launch) => launch.creator),
  );

  const withImages = (rows: LaunchWithCurve[]) =>
    rows.map((launch) =>
      shape(launch, images.get(launch.mint) ?? null, counts.get(launch.creator) ?? 1),
    );

  /**
   * Biggest first, and a token with no market cap yet goes to the bottom.
   *
   * The bonded lane arrives ordered by when each was last priced, which reads
   * as random to anybody looking at market caps. Sorting it here rather than in
   * the query because the market cap is derived from reserves in `shape`, not a
   * column to order by. A null cap is a token the pricing loop has not reached;
   * it sinks rather than sitting among the real numbers.
   */
  const byMarketCap = <T extends { marketCap: string | null }>(rows: T[]): T[] =>
    [...rows].sort((a, b) => {
      if (a.marketCap === null) return b.marketCap === null ? 0 : 1;
      if (b.marketCap === null) return -1;
      const left = BigInt(a.marketCap);
      const right = BigInt(b.marketCap);
      return left > right ? -1 : left < right ? 1 : 0;
    });

  const rate = await solUsd();
  const nowMs = Date.now();

  /*
   * The same rule the browser runs, on the same shape, from the same module.
   *
   * Sharing the function rather than reimplementing it in SQL is deliberate: a
   * filter that means one thing on the server and another in the browser is a
   * feed that disagrees with itself, and the difference would only ever show up
   * as a row that appears and then vanishes when the next update lands.
   */
  const apply = (lane: LaneKey, rows: ReturnType<typeof withImages>) => {
    const filters = laneFilters[lane];
    if (!isFiltered(filters)) return rows.slice(0, limit);
    return rows
      .filter((token) => matchesFilters(token, filters, { solUsd: rate, nowMs }))
      .slice(0, limit);
  };

  return Response.json({
    query: '',
    // Sent alongside rather than applied here: market caps stay lamports on
    // the wire, and the browser does the cosmetic conversion. One rate for the
    // whole page means every row on screen is priced the same way.
    solUsd: rate,
    lanes: {
      new: apply('new', withImages(fresh)),
      // Both of these rank by what a token is worth. Bonding used to arrive
      // ordered by curve progress, which is a different question from the
      // column of market caps beside it and reads as unsorted: a token at
      // 99.86% sat above one worth thirty thousand.
      bonding: apply('bonding', byMarketCap(withImages(bonding))),
      bonded: apply('bonded', byMarketCap(withImages(bonded))),
    },
    bondingFloorBps: BONDING_FLOOR_BPS,
  });
}

type LaneKey = 'new' | 'bonding' | 'bonded';

/** How much deeper to read when a lane is filtered, and the ceiling on it. */
const SCAN_MULTIPLE = 8;
const MAX_SCAN = 600;

function isFiltered(filters: Filters): boolean {
  return (
    filters.include.trim() !== '' ||
    filters.exclude.trim() !== '' ||
    filters.minMarketCapUsd > 0 ||
    filters.maxMarketCapUsd > 0 ||
    filters.minProgressPct > 0 ||
    filters.maxProgressPct > 0 ||
    filters.minAgeMin > 0 ||
    filters.maxAgeMin > 0 ||
    filters.maxCreatorLaunches > 0 ||
    filters.hideImageless
  );
}

/**
 * The filters off the query string, or the defaults.
 *
 * Every field is read individually and coerced, because this arrives from a
 * browser and nothing about it can be trusted to be the shape it claims. A
 * malformed payload filters nothing rather than failing the request: a feed
 * that returns an error because a filter was garbled is worse than one that
 * shows everything.
 */
function parseFilters(raw: string | null): Record<LaneKey, Filters> {
  const empty: Record<LaneKey, Filters> = {
    new: { ...DEFAULT_FILTERS },
    bonding: { ...DEFAULT_FILTERS },
    bonded: { ...DEFAULT_FILTERS },
  };
  if (!raw) return empty;

  try {
    const parsed = JSON.parse(raw) as Partial<Record<LaneKey, Partial<Filters>>>;
    const text = (value: unknown): string =>
      typeof value === 'string' ? value.slice(0, 200) : '';
    const count = (value: unknown): number => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1e12) : 0;
    };

    for (const lane of ['new', 'bonding', 'bonded'] as const) {
      const given = parsed[lane];
      if (!given) continue;
      empty[lane] = {
        include: text(given.include),
        exclude: text(given.exclude),
        minMarketCapUsd: count(given.minMarketCapUsd),
        maxMarketCapUsd: count(given.maxMarketCapUsd),
        minProgressPct: count(given.minProgressPct),
        maxProgressPct: count(given.maxProgressPct),
        minAgeMin: count(given.minAgeMin),
        maxAgeMin: count(given.maxAgeMin),
        maxCreatorLaunches: count(given.maxCreatorLaunches),
        hideImageless: given.hideImageless === true,
      };
    }
    return empty;
  } catch {
    return empty;
  }
}
