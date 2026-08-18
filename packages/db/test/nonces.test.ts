import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import {
  consumeChallenge,
  pruneExpiredChallenges,
  storeChallenge,
  upsertUser,
} from '../src/nonces';

const PUBKEY = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const NOW = 1_700_000_000_000;

let db: Client;

function challenge(nonce: string, expiresAt = NOW + 300_000, issuedAt = NOW) {
  return {
    nonce,
    pubkey: PUBKEY,
    domain: 'probatiotrade.com',
    uri: 'https://probatiotrade.com',
    issuedAt,
    expiresAt,
  };
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('challenges', () => {
  it('can be claimed once', async () => {
    await storeChallenge(db, challenge('n1'));
    const claimed = await consumeChallenge(db, 'n1', NOW);
    expect(claimed?.pubkey).toBe(PUBKEY);
  });

  it('cannot be claimed twice', async () => {
    await storeChallenge(db, challenge('n1'));
    await consumeChallenge(db, 'n1', NOW);

    const replay = await consumeChallenge(db, 'n1', NOW);
    expect(replay).toBeNull();
  });

  it('survives a race with only one winner', async () => {
    await storeChallenge(db, challenge('n1'));

    const results = await Promise.all([
      consumeChallenge(db, 'n1', NOW),
      consumeChallenge(db, 'n1', NOW),
      consumeChallenge(db, 'n1', NOW),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('returns null for a nonce that never existed', async () => {
    expect(await consumeChallenge(db, 'never-issued', NOW)).toBeNull();
  });

  it('rejects an expiry that precedes issuance', async () => {
    await expect(storeChallenge(db, challenge('n1', NOW - 1))).rejects.toThrow();
  });
});

describe('pruneExpiredChallenges', () => {
  it('removes only what can no longer be redeemed', async () => {
    await storeChallenge(db, challenge('stale', NOW - 1_000, NOW - 2_000));
    await storeChallenge(db, challenge('fresh', NOW + 300_000));

    const removed = await pruneExpiredChallenges(db, NOW);
    expect(removed).toBe(1);

    expect(await consumeChallenge(db, 'fresh', NOW)).not.toBeNull();
  });
});

describe('upsertUser', () => {
  it('creates a user on first sign-in', async () => {
    await upsertUser(db, PUBKEY, NOW);
    const result = await db.execute('SELECT COUNT(*) AS n FROM users');
    expect(Number(result.rows[0]!['n'])).toBe(1);
  });

  it('does not duplicate or overwrite on a later sign-in', async () => {
    await upsertUser(db, PUBKEY, NOW);
    await upsertUser(db, PUBKEY, NOW + 100_000);

    const result = await db.execute('SELECT COUNT(*) AS n, MIN(created_at) AS created FROM users');
    expect(Number(result.rows[0]!['n'])).toBe(1);
    expect(Number(result.rows[0]!['created'])).toBe(NOW);
  });
});
