import { describe, expect, it } from 'vitest';
import {
  SESSION_TTL_MS,
  SessionError,
  generateNonce,
  issueSession,
  readSession,
} from '../src/session';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);
const PUBKEY = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const NOW = 1_700_000_000_000;

describe('issueSession / readSession', () => {
  it('round-trips', () => {
    const token = issueSession(PUBKEY, SECRET, NOW);
    const payload = readSession(token, SECRET, NOW);
    expect(payload.pubkey).toBe(PUBKEY);
    expect(payload.issuedAt).toBe(NOW);
    expect(payload.expiresAt).toBe(NOW + SESSION_TTL_MS);
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueSession(PUBKEY, SECRET, NOW);
    expect(() => readSession(token, OTHER_SECRET, NOW)).toThrow(SessionError);
  });

  it('rejects a tampered payload', () => {
    const token = issueSession(PUBKEY, SECRET, NOW);
    const [, signature] = token.split('.') as [string, string];

    const forged = Buffer.from(
      JSON.stringify({ pubkey: 'someone-else', issuedAt: NOW, expiresAt: NOW + 1_000_000 }),
      'utf8',
    ).toString('base64url');

    expect(() => readSession(`${forged}.${signature}`, SECRET, NOW)).toThrow(
      /signature does not verify/,
    );
  });

  it('rejects a truncated signature', () => {
    const token = issueSession(PUBKEY, SECRET, NOW);
    const [payload, signature] = token.split('.') as [string, string];
    expect(() => readSession(`${payload}.${signature.slice(0, -4)}`, SECRET, NOW)).toThrow(
      SessionError,
    );
  });

  it('rejects an expired session', () => {
    const token = issueSession(PUBKEY, SECRET, NOW);
    expect(() => readSession(token, SECRET, NOW + SESSION_TTL_MS)).toThrow(/expired/);
  });

  it('rejects a malformed token', () => {
    expect(() => readSession('nonsense', SECRET, NOW)).toThrow(/malformed/);
    expect(() => readSession('a.b.c', SECRET, NOW)).toThrow(/malformed/);
  });

  it('refuses to run with a weak secret rather than looking secure', () => {
    expect(() => issueSession(PUBKEY, 'short', NOW)).toThrow(/at least 32 characters/);
    expect(() => issueSession(PUBKEY, '', NOW)).toThrow(/at least 32 characters/);
  });
});

describe('generateNonce', () => {
  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateNonce()));
    expect(seen.size).toBe(1000);
  });

  it('is URL-safe', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
