import { commitHistory, tradeHistory } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';

/**
 * The trade log.
 *
 * Append-only, so this is the whole story rather than a summary of it. Each
 * entry carries its leaf hash, which is what a trader hands to the verifier.
 *
 * And whether that leaf has actually been committed, which is not the same
 * question. A leaf hash is computed the moment a trade fills and exists whether
 * or not anything has ever reached the chain — with no keeper key configured,
 * nothing has. The log said "committed as" over a column of hashes regardless,
 * which is the one claim this product cannot afford to make loosely.
 */

const MAX_LIMIT = 500;
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) {
    return Response.json({ error: 'sign in to see your trades' }, { status: 401 });
  }

  const url = new URL(request.url);
  const mint = url.searchParams.get('mint');
  if (mint && !MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'that is not a valid mint' }, { status: 400 });
  }

  const requested = Number(url.searchParams.get('limit') ?? '100');
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT)
    : 100;

  const client = await db();
  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, user.pubkey, now);

  const trades = await tradeHistory(client, account.id, limit, mint ?? undefined);

  // Only confirmed commits count — `commitHistory` already filters to those.
  // A trade is committed when a confirmed batch covers its id.
  const commits = await commitHistory(client, seasonId, user.pubkey);
  const committed = (tradeId: number): boolean =>
    commits.some((commit) => tradeId >= commit.fromTradeId && tradeId <= commit.toTradeId);

  return Response.json({
    trades: trades.map((trade) => ({ ...trade, committed: committed(trade.id) })),
    // Said once for the whole log as well as per trade, so an interface can
    // explain the state rather than repeating "no" down a column.
    anyCommitted: commits.length > 0,
  });
}
