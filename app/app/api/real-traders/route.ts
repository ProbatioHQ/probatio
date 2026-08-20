import { observedBoard, observedCoverage } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Real pump.fun wallets, ranked on what they actually made.
 *
 * Built entirely from swaps already read off the chain to draw charts, so this
 * costs nothing beyond a query. Coverage is whatever pools have been walked,
 * which is the tokens people have opened here, and the response says so rather
 * than letting a reader assume it ranks all of pump.fun.
 */

export const dynamic = 'force-dynamic';

/**
 * A wallet has to have sold this many times to be ranked at all.
 *
 * Three, because one lucky exit is not a record and two is barely one.
 */
const MIN_TRIPS = 3;
/**
 * And to have had this much at risk on them, in lamports.
 *
 * A quarter of a SOL.
 *
 * A whole SOL was tried, on the reasoning that nobody copies a script trading
 * hundredths of one, and it was right about the wallets and wrong about the
 * page: it cut a board of ninety-eight scoreable wallets down to four rows. A
 * board nobody can scroll is worse than a board with some noise in it, and the
 * exits and the size are both on every row, so anybody can see for themselves
 * which rows are somebody trading and which are a script.
 */
const MIN_STAKED = 250_000_000n;
/** How many rows to send. The page shows them a screenful at a time. */
const PAGE_MAX = 200;
/** How far back to score. Long enough to mean something, short enough to be current. */
const WINDOW_DAYS = 30;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const client = await db();
  const since = Math.floor(Date.now() / 1_000) - WINDOW_DAYS * 24 * 60 * 60;

  const [board, coverage] = await Promise.all([
    observedBoard(client, { since, minTrips: MIN_TRIPS, minStaked: MIN_STAKED, limit: PAGE_MAX }),
    observedCoverage(client),
  ]);

  return Response.json({
    windowDays: WINDOW_DAYS,
    minTrips: MIN_TRIPS,
    minStaked: MIN_STAKED.toString(),
    /*
     * The honest caveat, in the payload rather than only in the prose, so
     * anything reading this knows how much of pump.fun it is looking at.
     *
     * `scoreable` is here because of how this board failed the first time: two
     * hundred wallets had been read and none of them cleared the floor, and
     * from the outside that was indistinguishable from nothing having been read
     * at all. An empty board should be able to say which of the two it is.
     */
    coverage: { ...coverage, scoreable: board.scoreable },
    traders: board.traders,
  });
}
