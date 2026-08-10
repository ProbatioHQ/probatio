import {
  bondedLaunches,
  bondingLaunches,
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

function shape(launch: LaunchWithCurve, image: string | null) {
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
    const mints = found.map((launch) => launch.mint);
    const images = await knownImages(mints);
    resolveLaunchImages(mints);

    return Response.json({
      query,
      solUsd: await solUsd(),
      results: found.map((launch) =>
        shape({ ...launch, curve: null }, images.get(launch.mint) ?? null),
      ),
    });
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

  const withImages = (rows: LaunchWithCurve[]) =>
    rows.map((launch) => shape(launch, images.get(launch.mint) ?? null));

  return Response.json({
    query: '',
    // Sent alongside rather than applied here: market caps stay lamports on
    // the wire, and the browser does the cosmetic conversion. One rate for the
    // whole page means every row on screen is priced the same way.
    solUsd: await solUsd(),
    lanes: {
      new: withImages(fresh),
      bonding: withImages(bonding),
      bonded: withImages(bonded),
    },
    bondingFloorBps: BONDING_FLOOR_BPS,
  });
}
