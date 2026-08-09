import {
  CHALLENGE_TTL_MS,
  buildSignInMessage,
  decodePubkey,
  generateNonce,
} from '@probatio/auth';
import { pruneExpiredChallenges, storeChallenge } from '@probatio/db';
import { db } from '@/lib/db';
import { appDomain, appUri } from '@/lib/env';

/**
 * Issue a sign-in challenge.
 *
 * The response includes the exact message to sign, but that text is a
 * convenience for the wallet — it is never trusted on the way back. Verification
 * rebuilds the message from the stored challenge.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const pubkey = (body as { pubkey?: unknown })?.pubkey;
  if (typeof pubkey !== 'string') {
    return Response.json({ error: 'pubkey is required' }, { status: 400 });
  }

  try {
    decodePubkey(pubkey);
  } catch {
    return Response.json({ error: 'not a valid Solana address' }, { status: 400 });
  }

  const now = Date.now();
  const challenge = {
    pubkey,
    nonce: generateNonce(),
    domain: appDomain(),
    uri: appUri(),
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
  };

  const client = await db();
  await pruneExpiredChallenges(client, now);
  await storeChallenge(client, challenge);

  return Response.json({
    nonce: challenge.nonce,
    message: buildSignInMessage(challenge),
    expiresAt: challenge.expiresAt,
  });
}
