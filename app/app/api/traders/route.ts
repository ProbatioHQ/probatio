import { db } from '@/lib/db';
import { allTimeBoard } from '@/lib/leaderboard';
import { rateLimit } from '@/lib/rate-limit';
import { namesFor } from '@probatio/db';

/**
 * Everybody who trades here, across every season.
 *
 * Separate from /api/leaderboard, which answers about one season and should
 * keep doing exactly that. This is the "who is here" question, and it is the
 * one a visitor is really asking when they look for a leaderboard.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'chainRead');
  if (throttled.response) return throttled.response;

  const client = await db();
  const board = await allTimeBoard(client, Date.now());

  // Names in one query for the whole board, not one per row.
  const names = await namesFor(
    client,
    board.standings.map((standing) => standing.trader),
  );

  return Response.json({
    markedAt: board.markedAt,
    total: board.standings.length,
    // Whatever could not be priced is named rather than quietly held at cost,
    // so a reader can tell a flat board from an unreadable one.
    unpriced: board.unpriced,
    standings: board.standings.map((standing) => ({
      ...standing,
      name: names.get(standing.trader) ?? null,
    })),
  });
}
