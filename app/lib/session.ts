import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  readSession,
  type SessionPayload,
} from '@probatio/auth';
import { revokeSessions, sessionEpoch } from '@probatio/db';
import { db } from './db';
import { sessionSecret } from './env';

/**
 * The signed-in wallet, or null.
 *
 * Any problem with the token — forged, expired, truncated, revoked — reads as
 * "not signed in" rather than as an error. There is nothing a caller could
 * usefully do differently, and distinguishing the cases would tell an attacker
 * which of their guesses got closer.
 *
 * Two checks, not one. The signature proves the token was issued by this server
 * and has not been altered; the epoch proves it has not been withdrawn since.
 * Without the second, a cookie copied off a shared machine stayed valid for its
 * full life and nothing its owner did could stop it — the signature is correct
 * forever, so something outside the token has to be able to refuse it.
 */

/**
 * Memoised for the life of one request.
 *
 * `currentUser` is called by sixteen routes and by server components, several
 * times within a single render. Without this the epoch check would turn one
 * request into a handful of identical queries — which is how a security check
 * becomes something somebody later removes for being slow.
 */
const epochFor = cache(async (pubkey: string): Promise<number> => {
  return sessionEpoch(await db(), pubkey);
});

export const currentUser = cache(async (): Promise<SessionPayload | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  let payload: SessionPayload;
  try {
    payload = readSession(token, sessionSecret(), Date.now());
  } catch {
    return null;
  }

  try {
    // Tokens issued before the epoch existed carry none, and every wallet
    // starts at zero — so those still read, rather than signing everybody out
    // the moment this deployed.
    const current = await epochFor(payload.pubkey);
    if ((payload.epoch ?? 0) < current) return null;
  } catch {
    /*
     * The database is unreachable.
     *
     * Failing open here would make an outage a window in which revoked tokens
     * work again, which is exactly when somebody would want them to. Failing
     * closed signs everybody out during an outage, which is visible, recoverable
     * and does not hand anything to an attacker. Closed.
     */
    return null;
  }

  return payload;
});

export async function startSession(pubkey: string): Promise<void> {
  const store = await cookies();
  // Stamped with the wallet's current generation, so a token issued now
  // survives until the next revocation rather than being born stale.
  const epoch = await sessionEpoch(await db(), pubkey);
  const token = issueSession(pubkey, sessionSecret(), Date.now(), epoch);

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/**
 * Sign out, everywhere.
 *
 * Deleting the cookie only ends the session in the browser doing the deleting;
 * any copy taken elsewhere keeps working. Raising the epoch is what actually
 * ends it, and doing that on an ordinary sign-out is deliberate — somebody
 * signing out of a shared machine means it, and a session that ends only on the
 * device you happen to be holding is not a session that ends.
 */
export async function endSession(pubkey: string | null): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);

  if (!pubkey) return;
  try {
    await revokeSessions(await db(), pubkey);
  } catch {
    // The cookie is already gone from this browser. A failure to revoke the
    // rest is worth logging, not worth failing the request the user made.
    console.error('[auth] could not revoke sessions for', pubkey);
  }
}
