import type { Client } from '@libsql/client';

export interface StoredChallenge {
  readonly nonce: string;
  readonly pubkey: string;
  readonly domain: string;
  readonly uri: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

export async function storeChallenge(
  db: Client,
  challenge: Omit<StoredChallenge, 'consumedAt'>,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO auth_nonces (nonce, pubkey, domain, uri, issued_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      challenge.nonce,
      challenge.pubkey,
      challenge.domain,
      challenge.uri,
      challenge.issuedAt,
      challenge.expiresAt,
    ],
  });
}

/**
 * Claim a challenge for redemption.
 *
 * The UPDATE carries `consumed_at IS NULL` in its WHERE clause, so two requests
 * racing with the same nonce cannot both succeed — SQLite serialises the
 * writes and the loser sees zero rows affected. Checking first and then
 * updating would leave exactly that gap open.
 *
 * Returns the challenge if this caller won the claim, and null if it was
 * already spent or never existed.
 */
export async function consumeChallenge(
  db: Client,
  nonce: string,
  now: number,
): Promise<StoredChallenge | null> {
  const claimed = await db.execute({
    sql: `UPDATE auth_nonces SET consumed_at = ?
          WHERE nonce = ? AND consumed_at IS NULL
          RETURNING nonce, pubkey, domain, uri, issued_at, expires_at, consumed_at`,
    args: [now, nonce],
  });

  const row = claimed.rows[0];
  if (!row) return null;

  return {
    nonce: String(row['nonce']),
    pubkey: String(row['pubkey']),
    domain: String(row['domain']),
    uri: String(row['uri']),
    issuedAt: Number(row['issued_at']),
    expiresAt: Number(row['expires_at']),
    consumedAt: row['consumed_at'] === null ? null : Number(row['consumed_at']),
  };
}

/** Drop challenges that can no longer be redeemed. Safe to call at any time. */
export async function pruneExpiredChallenges(db: Client, now: number): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM auth_nonces WHERE expires_at < ?',
    args: [now],
  });
  return Number(result.rowsAffected);
}

/** Create the user row on first sign-in. Idempotent. */
export async function upsertUser(db: Client, pubkey: string, now: number): Promise<void> {
  await db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?) ON CONFLICT (pubkey) DO NOTHING',
    args: [pubkey, now],
  });
}
