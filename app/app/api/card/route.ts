import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';
import { cardsFor } from '@/lib/trade-card';

/**
 * The closed trades this account could make a card from.
 *
 * Only your own. A record here is public and a profile can be read by anybody,
 * but a card is a thing somebody chooses to publish about themselves, and
 * handing one person a ready-made image of another person's trade is a
 * different act from letting them look one up.
 */
export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  const client = await db();
  const now = Date.now();
  const { account } = await activeSeason(client, user.pubkey, now);

  return Response.json({ trades: await cardsFor(client, account.id) });
}
