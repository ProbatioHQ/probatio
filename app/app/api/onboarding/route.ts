import { tradeHistory } from '@probatio/db';
import { db } from '@/lib/db';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';

/**
 * How far into the product someone has actually got.
 *
 * Derived from what they have done rather than stored as a flag. A flag can
 * disagree with reality — set on a trade that later failed to write, or lost
 * when a row is rebuilt — and then the guide insists someone has not done
 * something they plainly have. A count cannot be wrong about itself.
 */

export async function GET(): Promise<Response> {
  const user = await currentUser();

  if (!user) {
    return Response.json({ signedIn: false, tradeCount: 0, done: false });
  }

  const client = await db();
  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, user.pubkey, now);

  // One is enough. The guide exists to get someone to their first fill, not to
  // supervise them afterwards.
  const trades = await tradeHistory(client, account.id, 1);

  return Response.json({
    signedIn: true,
    pubkey: user.pubkey,
    tradeCount: trades.length,
    done: trades.length > 0,
  });
}
