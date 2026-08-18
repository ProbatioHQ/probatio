import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason, balances } from '@/lib/season';
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
    const now = Date.now();
    const [{ account }, both] = await Promise.all([
      activeSeason(client, user.pubkey, now),
      balances(client, user.pubkey, now),
    ]);

    return Response.json(
      {
        // The account trading currently lands in, which is what the trade
        // panel spends against.
        balance: account.solBalance,
        startingBalance: account.startingBalance,
        // Both of them, named, so the header can show where somebody stands
        // rather than one figure that silently changes meaning.
        free: both.free,
        ranked: both.ranked,
      },
      // Never cached, anywhere. A balance is only worth showing if it is the
      // one the account holds right now.
      { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
    );
  } catch (error) {
    // A header that shows nothing is the symptom of a 500 nobody is looking at,
    // so the reason is logged and answered rather than thrown away.
    console.error('[balance] failed for', user.pubkey, error);
    // The reason travels with the failure. This is the caller's own account on
    // an open-source practice app, and a bare 503 repeated in a console is what
    // made this take as long as it did to find.
    return Response.json(
      {
        error: 'balance unavailable',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }
}
