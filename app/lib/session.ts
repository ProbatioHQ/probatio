import 'server-only';
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  readSession,
  type SessionPayload,
} from '@probatio/auth';
import { sessionSecret } from './env';

/**
 * The signed-in wallet, or null.
 *
 * Any problem with the token — forged, expired, truncated — reads as "not
 * signed in" rather than as an error. There is nothing a caller could usefully
 * do differently, and distinguishing the cases would tell an attacker which of
 * their guesses got closer.
 */
export async function currentUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    return readSession(token, sessionSecret(), Date.now());
  } catch {
    return null;
  }
}

export async function startSession(pubkey: string): Promise<void> {
  const store = await cookies();
  const token = issueSession(pubkey, sessionSecret(), Date.now());

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
