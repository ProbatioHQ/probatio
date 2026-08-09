import { AuthError, verifySignIn } from '@probatio/auth';
import { consumeChallenge, upsertUser } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { startSession } from '@/lib/session';

/**
 * Redeem a signed challenge for a session.
 *
 * The challenge is consumed before the signature is checked. That ordering is
 * deliberate: a nonce is spent by the attempt, not by the success, so a wrong
 * signature cannot be retried against the same nonce while an attacker looks
 * for one that lands.
 */
export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'auth');
  if (throttled.response) return throttled.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const { pubkey, nonce, signature } = (body ?? {}) as Record<string, unknown>;
  if (typeof pubkey !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
    return Response.json(
      { error: 'pubkey, nonce and signature are all required' },
      { status: 400 },
    );
  }

  const now = Date.now();
  const client = await db();

  const challenge = await consumeChallenge(client, nonce, now);
  if (!challenge) {
    return Response.json(
      { error: 'that sign-in request has already been used or has expired' },
      { status: 401 },
    );
  }

  try {
    verifySignIn({ challenge, signature, claimedPubkey: pubkey, now });
  } catch (error) {
    if (error instanceof AuthError) {
      return Response.json({ error: error.message, code: error.code }, { status: 401 });
    }
    throw error;
  }

  await upsertUser(client, challenge.pubkey, now);
  await startSession(challenge.pubkey);

  return Response.json({ pubkey: challenge.pubkey });
}
