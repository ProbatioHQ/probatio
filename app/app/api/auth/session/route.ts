import { rateLimit } from '@/lib/rate-limit';
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
  return Response.json(
    user ? { pubkey: user.pubkey, expiresAt: user.expiresAt } : { pubkey: null },
  );
}
