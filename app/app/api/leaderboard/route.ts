import { currentRankedSeason, ensureFreePlaySeason, seasonTotals } from '@probatio/db';
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

  const limit = Math.min(Number(url.searchParams.get('limit') ?? PAGE) || PAGE, 200);
  const user = await currentUser();

  const shown = board.standings.slice(0, limit).map((standing) => ({
    rank: standing.rank,
    trader: standing.trader,
    returnBps: standing.returnBps,
    finalEquity: standing.finalEquity.toString(),
    tradeCount: standing.tradeCount,
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
          returnBps: mine.returnBps,
          finalEquity: mine.finalEquity.toString(),
          tradeCount: mine.tradeCount,
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
