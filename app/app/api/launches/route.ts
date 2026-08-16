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
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { knownImages, resolveLaunchImages } from '@/lib/token-images';
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
function marketCapOf(launch: LaunchWithCurve): string | null {
  const curve = launch.curve;
  if (!curve?.virtualSolReserves || !curve.virtualTokenReserves) return null;
  if (curve.virtualTokenReserves <= 0n) return null;

  const price = priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves);
  return marketCapLamports(price, PUMPFUN_TOKEN_TOTAL_SUPPLY).toString();
}

function shape(launch: LaunchWithCurve, image: string | null, creatorLaunches: number) {
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
    marketCap: marketCapOf(launch),
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

    const results = [
      ...found.map((launch) =>
        shape(
          { ...launch, curve: null },
          images.get(launch.mint) ?? null,
          searchCounts.get(launch.creator) ?? 1,
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
        marketCap: capLamports(token.marketCapUsd),
      })),
    ].slice(0, limit);

    return Response.json({ query, solUsd: sol, results });
  }

  const [fresh, bonding, bonded] = await Promise.all([
    newLaunches(client, limit),
    bondingLaunches(client, BONDING_FLOOR_BPS, limit),
    bondedLaunches(client, limit),
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

  return Response.json({
    query: '',
    // Sent alongside rather than applied here: market caps stay lamports on
    // the wire, and the browser does the cosmetic conversion. One rate for the
    // whole page means every row on screen is priced the same way.
    solUsd: await solUsd(),
    lanes: {
      new: withImages(fresh),
      bonding: withImages(bonding),
      bonded: byMarketCap(withImages(bonded)),
    },
    bondingFloorBps: BONDING_FLOOR_BPS,
  });
}
