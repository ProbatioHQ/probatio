import { currentRankedSeason, ensureFreePlaySeason, namesFor, seasonTotals } from '@probatio/db';
import { distribute, rulesetFor, statusAt } from '@probatio/seasons';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { seasonBoard } from '@/lib/leaderboard';
import { currentUser } from '@/lib/session';

/**
 * The standings.
 *
 * Public, and deliberately so: the whole argument of the product is that a
 * record can be checked, and a leaderboard nobody outside can read is just an
 * assertion with a table around it.
 *
 * Live standings are marked to the market and therefore move. That is stated in
 * the response rather than implied — a trader who refreshes and drops a place
 * should know it was the market and not a recount.
 */

const PAGE = 50;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const client = await db();
  const now = Date.now();
  const url = new URL(request.url);

  const season = await currentRankedSeason(client, now);
  // Free play has no leaderboard: no entry, no pot, nothing to rank for.
  if (!season || season.startsAt === null || season.endsAt === null) {
    await ensureFreePlaySeason(client, now);
    return Response.json({ season: null, standings: [], final: false });
  }

  const status = statusAt(
    {
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      entryClosesAt: season.entryClosesAt ?? season.endsAt,
      finalizedAt: season.status === 'finalized' ? season.endsAt : null,
    },
    now,
  );

  const board = await seasonBoard(client, season.id, now);
  const totals = await seasonTotals(client, season.id);
  const split = distribute(rulesetFor(season.ordinal), totals.potLamports, totals.entrants, {
    houseBaseLamports: totals.entriesLamports,
  });
  const payoutByPlace = new Map(split.payouts.map((payout) => [payout.place, payout.lamports]));

  // Clamped at both ends. Without a lower bound a negative limit made
  // `standings.slice(0, limit)` drop rows off the end instead of paging, and
  // put every real rank above the limit so the caller's own row was appended a
  // second time.
  const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get('limit') ?? PAGE)) || PAGE, 1), 200);
  const user = await currentUser();

  const page = board.standings.slice(0, limit);

  // Looked up in one query for the whole page rather than per row. A board is
  // a list of strangers until the people on it have names.
  const names = await namesFor(
    client,
    [...new Set([...page.map((standing) => standing.trader), ...(user ? [user.pubkey] : [])])],
  );

  const shown = page.map((standing) => ({
    rank: standing.rank,
    trader: standing.trader,
    name: names.get(standing.trader) ?? null,
    returnBps: standing.returnBps,
    finalEquity: standing.finalEquity.toString(),
    startingBalance: standing.startingBalance.toString(),
    tradeCount: standing.tradeCount,
    /*
     * How this row was traded, not where it belongs.
     *
     * True only when every order came from a program. A trader who ran a
     * strategy and also clicked is not "a bot", and labelling them one would be
     * the sort of tidy that is simply untrue. Same board, same ranking either
     * way: this changes a label and nothing else.
     */
    automated: standing.tradeCount > 0 && (standing.automatedTrades ?? 0) === standing.tradeCount,
    payoutLamports: (payoutByPlace.get(standing.rank) ?? 0n).toString(),
  }));

  // A trader outside the page still gets their own row. Being told your place
  // is 214th is the reason to come back; having to page to find it is not.
  const mine = user ? board.standings.find((s) => s.trader === user.pubkey) : undefined;
  const you =
    mine && mine.rank > limit
      ? {
          rank: mine.rank,
          trader: mine.trader,
          name: names.get(mine.trader) ?? null,
          returnBps: mine.returnBps,
          finalEquity: mine.finalEquity.toString(),
          startingBalance: mine.startingBalance.toString(),
          tradeCount: mine.tradeCount,
          automated: mine.tradeCount > 0 && (mine.automatedTrades ?? 0) === mine.tradeCount,
          payoutLamports: (payoutByPlace.get(mine.rank) ?? 0n).toString(),
        }
      : null;

  return Response.json({
    season: {
      ordinal: season.ordinal,
      name: season.name,
      status,
      entrants: board.standings.length,
      potLamports: totals.potLamports.toString(),
      scoring: 'highest_return',
    },
    standings: shown,
    you,
    total: board.standings.length,
    // Until the season closes these move with the market, not with a recount.
    final: status === 'finalized',
    markedAt: board.markedAt,
    unpricedMints: board.unpriced.length,
  });
}
