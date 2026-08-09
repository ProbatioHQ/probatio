import { recentLaunches, searchLaunches } from '@probatio/db';
import { db } from '@/lib/db';

/**
 * The launch feed, and search over it.
 *
 * Open to anyone. Discovery is what a visitor sees before they have a wallet,
 * and putting it behind a sign-in would mean the first thing a new arrival
 * meets is a login wall in front of an empty room.
 */

const MAX_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get('q')?.trim() ?? '';

  const requested = Number(url.searchParams.get('limit') ?? '30');
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : 30;

  const client = await db();
  const launches = query
    ? await searchLaunches(client, query, limit)
    : await recentLaunches(client, limit);

  return Response.json({ query, launches });
}
