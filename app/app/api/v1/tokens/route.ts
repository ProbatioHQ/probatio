import { marketCapLamports, priceFromReserves } from '@probatio/candles';
import {
  creatorLaunchCounts,
  getManyTokenMetadata,
  launchedAtMs,
  newLaunches,
} from '@probatio/db';
import { PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { db } from '@/lib/db';
import { ranking } from '@/lib/explore';
import { rateLimit } from '@/lib/rate-limit';
import { authenticate, refuse } from '@/lib/strategy-auth';

/**
 * What there is to trade.
 *
 * The same list the hosted runner checks its entry conditions against, offered
 * here so that a program does not have to scrape the site to find out what
 * exists. Two sources, and the response says which one each token came from,
 * because they know different things and pretending otherwise would be the
 * expensive kind of tidy.
 *
 * `launch` rows come from this site's own launch table and carry a curve's
 * reserves, so their age, depth and market cap are exact. `board` rows come from
 * pump.fun's ranking and carry a move and a dollar market cap, so their depth is
 * unstated rather than guessed at.
 *
 * Every field here is cached or from the database. Nothing in this endpoint
 * reads the chain, which is why it can be polled: the chain is read when an
 * order is placed and not before.
 */

const MAX_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  /*
   * Authenticated first, then throttled by whose key it is.
   *
   * The order matters. Throttling first would count this request against a
   * network address, because a program sends no session cookie, so two bots
   * behind one connection would throttle each other while the key in the header
   * named each of them exactly. Authenticating costs one indexed lookup of a
   * hash, and a caller with no valid key is still bounded by address below.
   */
  const { auth } = await authenticate(request);
  if (!auth.ok) {
    const flood = await rateLimit(request, 'api-read');
    if (flood.response) return flood.response;
    return refuse(auth.status, auth.error);
  }

  const throttled = await rateLimit(request, 'api-read', 1, auth.pubkey);
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const asked = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), MAX_LIMIT) : 50;

  const client = await db();
  const now = Date.now();

  const tokens: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  const fresh = await newLaunches(client, limit);
  /* Batched for the whole page, so this stays a request a program may poll. */
  const [socials, launchCounts] = await Promise.all([
    getManyTokenMetadata(client, fresh.map((launch) => launch.mint)),
    creatorLaunchCounts(client, fresh.map((launch) => launch.creator)),
  ]);

  for (const launch of fresh) {
    const curve = launch.curve;
    if (!curve || curve.virtualSolReserves === null || curve.virtualTokenReserves === null) continue;
    seen.add(launch.mint);
    tokens.push({
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      source: 'launch',
      graduated: false,
      ageSeconds: Math.max(0, Math.floor((now - launchedAtMs(launch.launchedAt)) / 1_000)),
      /*
       * The real reserve, not the virtual one. A curve prices against virtual
       * reserves and can only hand over the real ones, so reporting the virtual
       * figure as depth would tell a program a curve holds thirty SOL when it
       * holds two. Every impact cap in this system exists because that
       * difference is the whole trade.
       */
      liquidityLamports: curve.realSolReserves.toString(),
      marketCapLamports: marketCapLamports(
        priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves),
        PUMPFUN_TOKEN_TOTAL_SUPPLY,
      ).toString(),
      progressBps: curve.progressBps,
      changeBps: null,
      creator: launch.creator,
      /*
       * Null where the metadata has not been read yet, which is common in a
       * token's first seconds and is not the same as "it named none". A program
       * treating null as false would buy exactly the launches it was trying to
       * avoid.
       */
      hasTwitter: socials.has(launch.mint)
        ? (socials.get(launch.mint)?.twitterUrl ?? '').trim().length > 0
        : null,
      hasWebsite: socials.has(launch.mint)
        ? (socials.get(launch.mint)?.websiteUrl ?? '').trim().length > 0
        : null,
      // How many launches this site has indexed from them: a floor on their
      // history rather than the whole of it.
      creatorLaunches: launchCounts.get(launch.creator) ?? 1,
    });
  }

  try {
    for (const row of await ranking()) {
      if (tokens.length >= limit) break;
      if (row.mint === '' || seen.has(row.mint)) continue;
      tokens.push({
        mint: row.mint,
        name: row.name,
        symbol: row.symbol,
        source: 'board',
        graduated: true,
        ageSeconds: Math.max(0, Math.floor((now - launchedAtMs(row.createdAt)) / 1_000)),
        // Unstated rather than converted with a guessed SOL rate. A program
        // reading these should treat null as "not known", not as zero.
        liquidityLamports: null,
        marketCapLamports: null,
        marketCapUsd: row.marketCapUsd,
        changeBps: row.changeH1 === null ? null : Math.round(row.changeH1 * 100),
        creator: row.creator || null,
        hasTwitter: null,
        hasWebsite: null,
        creatorLaunches: null,
      });
    }
  } catch {
    // Somebody else's service. Without it there are still launches.
  }

  return Response.json({
    tokens: tokens.slice(0, limit),
    note: 'Nothing here reads the chain, so these figures are as fresh as the caches behind them: seconds for launches, about a minute for the board. The pool is read when you place an order, and that read is what you are filled against.',
  });
}
