import { rateLimit } from '@/lib/rate-limit';
import { currentUser, endSession } from '@/lib/session';

/**
 * Sign out.
 *
 * Reads the session first so it knows whose to revoke. A signed-out caller is
 * not an error — deleting a cookie that is already gone is the outcome they
 * asked for either way.
 */
export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  await endSession(user?.pubkey ?? null);

  return Response.json({ ok: true });
}
