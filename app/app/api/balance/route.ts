import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';

/**
 * The cash balance, and nothing else.
 *
 * The header shows this on every page and re-reads it on a timer, so it needs
 * to be the cheapest read in the system. It used to come from `/api/positions`,
 * which marks every open position to market — one chain read each — and sits
 * under the chain-read limit. A header pill was therefore spending the same
 * budget as a trade quote, and when that budget ran out or an RPC was slow the
 * pill showed nothing at all rather than the number it exists to show.
 *
 * This reads one row. No chain, no pricing, no positions.
 */
export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) {
    return Response.json({ error: 'sign in to see your balance' }, { status: 401 });
  }

  try {
    const client = await db();
    const { account } = await activeSeason(client, user.pubkey, Date.now());

    return Response.json({
      balance: account.solBalance,
      startingBalance: account.startingBalance,
    });
  } catch (error) {
    // A header that shows nothing is the symptom of a 500 nobody is looking at,
    // so the reason is logged and answered rather than thrown away.
    console.error('[balance] failed for', user.pubkey, error);
    return Response.json({ error: 'balance unavailable' }, { status: 503 });
  }
}
