import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';

/**
 * Who is signed in.
 *
 * Cheap, but polled by every page load and it verifies an HMAC on the way
 * through. Limited so that verifying signatures cannot be turned into work on
 * demand.
 */
export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ pubkey: null });

  /*
   * The balance travels with the identity.
   *
   * This is the one authenticated read that is known to be working whenever
   * anybody is signed in, because its answer is what puts the wallet into its
   * signed-in state at all. Sending the balance with it means the header has a
   * number from the first render rather than depending on a second request
   * succeeding, which is what it was doing when the pill sat empty.
   *
   * Guarded on its own, so that a database that cannot answer for the balance
   * still answers for the session. Signing in must never depend on this.
   */
  let balance: string | null = null;
  try {
    const client = await db();
    const { account } = await activeSeason(client, user.pubkey, Date.now());
    balance = account.solBalance;
  } catch (error) {
    console.error('[session] balance unavailable for', user.pubkey, error);
  }

  return Response.json(
    { pubkey: user.pubkey, expiresAt: user.expiresAt, balance },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  );
}
