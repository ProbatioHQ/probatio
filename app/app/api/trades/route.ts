import { tradeHistory } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';

/**
 * The trade log.
 *
 * Append-only, so this is the whole story rather than a summary of it. Each
 * entry carries its leaf hash, which is what a trader hands to the verifier to
 * prove the trade is committed.
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

  return Response.json({ trades });
}
