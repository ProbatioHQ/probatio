import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens.
 *
 * A token is `base64url(payload).base64url(hmac)`. The payload is readable —
 * it holds a wallet address that is public anyway — but it cannot be altered
 * without the server secret, and the comparison is constant-time so the tag
 * cannot be recovered a byte at a time by timing the response.
 */

export const SESSION_COOKIE = 'probatio_session' as const;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionPayload {
  readonly pubkey: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

function base64urlEncode(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payloadPart: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadPart).digest();
}

export function issueSession(
  pubkey: string,
  secret: string,
  now: number,
  ttlMs: number = SESSION_TTL_MS,
): string {
  assertUsableSecret(secret);

  const payload: SessionPayload = {
    pubkey,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };

  const payloadPart = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signaturePart = base64urlEncode(sign(payloadPart, secret));
  return `${payloadPart}.${signaturePart}`;
}

export function readSession(token: string, secret: string, now: number): SessionPayload {
  assertUsableSecret(secret);

  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new SessionError('malformed session token');
  }
  const [payloadPart, signaturePart] = parts as [string, string];

  const expected = sign(payloadPart, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(signaturePart, 'base64url');
  } catch {
    throw new SessionError('malformed session signature');
  }

  // Lengths must match before timingSafeEqual, and comparing lengths first
  // leaks nothing an attacker does not already control.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new SessionError('session signature does not verify');
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    throw new SessionError('session payload is not valid JSON');
  }

  if (
    typeof payload.pubkey !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.expiresAt !== 'number'
  ) {
    throw new SessionError('session payload is missing fields');
  }

  if (now >= payload.expiresAt) {
    throw new SessionError('session has expired');
  }

  return payload;
}

/**
 * A short or absent secret makes every token above forgeable, so this refuses
 * to run rather than starting up in a state that only looks secure.
 */
function assertUsableSecret(secret: string): void {
  if (!secret || secret.length < 32) {
    throw new SessionError(
      'SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32',
    );
  }
}

/** A fresh, URL-safe nonce for a sign-in challenge. */
export function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}
