import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nameKey, validateName } from '@probatio/profile';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { activeName, claimName, clearName, nameRecord, namesFor, upsertUser } from '../src/index';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const NOW = 1_700_000_000_000;

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  for (const key of [A, B]) await upsertUser(harness.db, key, NOW);
});

afterEach(() => harness.cleanup());

function claim(pubkey: string, raw: string) {
  const name = validateName(raw);
  return claimName(harness.db, pubkey, name, nameKey(name), NOW);
}

describe('claiming', () => {
  it('takes a free name', async () => {
    expect(await claim(A, 'Alice')).toBe('claimed');
    expect(await activeName(harness.db, A)).toBe('Alice');
  });

  it('refuses one somebody else holds', async () => {
    await claim(A, 'Alice');
    expect(await claim(B, 'Alice')).toBe('taken');
    expect(await activeName(harness.db, B)).toBeNull();
  });

  it('refuses a name that only looks different', async () => {
    // Uniqueness is on the folded key: two strings a reader cannot tell apart
    // are one name for the purpose of impersonating somebody.
    await claim(A, 'Alice');
    expect(await claim(B, 'A1ice')).toBe('taken');
    expect(await claim(B, 'al-ice')).toBe('taken');
  });

  it('lets a holder restyle their own name', async () => {
    await claim(A, 'alice');
    expect(await claim(A, 'ALICE')).toBe('already_yours');
    expect(await activeName(harness.db, A)).toBe('ALICE');
  });

  it('lets a trader change to a different free name', async () => {
    await claim(A, 'Alice');
    expect(await claim(A, 'Bobby')).toBe('claimed');
    expect(await activeName(harness.db, A)).toBe('Bobby');
  });

  it('keeps the old key reserved when a trader renames', async () => {
    // Otherwise renaming is a way to park a name for somebody else to take a
    // second later.
    await claim(A, 'Alice');
    await claim(A, 'Bobby');
    expect(await claim(B, 'Alice')).toBe('taken');
  });
});

describe('taking a name away', () => {
  it('clears it and records why', async () => {
    await claim(A, 'Alice');
    expect(await clearName(harness.db, A, 'impersonation', NOW + 1)).toBe(true);

    expect(await activeName(harness.db, A)).toBeNull();
    const record = await nameRecord(harness.db, A);
    expect(record?.clearedNote).toBe('impersonation');
  });

  it('keeps the key reserved afterwards', async () => {
    // Releasing a moderated name back into the pool hands it to whoever was
    // waiting for exactly that.
    await claim(A, 'Alice');
    await clearName(harness.db, A, 'impersonation', NOW + 1);
    expect(await claim(B, 'Alice')).toBe('taken');
  });

  it('does not let the original holder take it back', async () => {
    await claim(A, 'Alice');
    await clearName(harness.db, A, 'impersonation', NOW + 1);
    expect(await claim(A, 'Alice')).toBe('taken');
  });

  it('lets a cleared trader claim a different name', async () => {
    // The person is not banned; the string is.
    await claim(A, 'Alice');
    await clearName(harness.db, A, 'impersonation', NOW + 1);
    expect(await claim(A, 'Carol')).toBe('claimed');
    expect(await activeName(harness.db, A)).toBe('Carol');
  });

  it('does nothing when there is no name to clear', async () => {
    expect(await clearName(harness.db, A, 'none', NOW)).toBe(false);
  });

  it('is not undone by clearing twice', async () => {
    await claim(A, 'Alice');
    await clearName(harness.db, A, 'first', NOW + 1);
    expect(await clearName(harness.db, A, 'second', NOW + 2)).toBe(false);
    expect((await nameRecord(harness.db, A))?.clearedNote).toBe('first');
  });
});

describe('reading names in bulk', () => {
  it('returns only the ones that exist', async () => {
    await claim(A, 'Alice');
    const names = await namesFor(harness.db, [A, B]);
    expect(names.get(A)).toBe('Alice');
    expect(names.has(B)).toBe(false);
  });

  it('leaves out a cleared name', async () => {
    await claim(A, 'Alice');
    await clearName(harness.db, A, 'impersonation', NOW + 1);
    expect((await namesFor(harness.db, [A])).size).toBe(0);
  });

  it('asks nothing for an empty list', async () => {
    expect((await namesFor(harness.db, [])).size).toBe(0);
  });
});
