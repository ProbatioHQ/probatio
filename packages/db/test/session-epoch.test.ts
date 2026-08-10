import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { revokeSessions, sessionEpoch, upsertUser } from '../src/index';

/**
 * Withdrawing a session.
 *
 * Session tokens are stateless — an HMAC over a payload, valid as long as the
 * signature checks and the clock allows. That is cheap to verify and impossible
 * to take back, so a cookie copied off a shared machine kept working no matter
 * what its owner did. The epoch is the one thing that can refuse it.
 */

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER = '9oNfewPW6KSxbKbTUCQ3g7tc2gViCEYijc6TbDaumwg1';
const NOW = 1_700_000_000_000;

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, NOW);
});

afterEach(() => harness.cleanup());

describe('the session epoch', () => {
  it('starts at zero for a new wallet', async () => {
    expect(await sessionEpoch(harness.db, PUBKEY)).toBe(0);
  });

  it('reads zero for a wallet that has never signed in', async () => {
    // The signature already proved the wallet. An unknown one is not a reason
    // to fail closed on its own — the row appears on first sign-in.
    expect(await sessionEpoch(harness.db, OTHER)).toBe(0);
  });

  it('moves forward when sessions are revoked', async () => {
    expect(await revokeSessions(harness.db, PUBKEY)).toBe(1);
    expect(await sessionEpoch(harness.db, PUBKEY)).toBe(1);
  });

  it('keeps moving forward, so an old token never becomes valid again', async () => {
    await revokeSessions(harness.db, PUBKEY);
    await revokeSessions(harness.db, PUBKEY);
    await revokeSessions(harness.db, PUBKEY);
    expect(await sessionEpoch(harness.db, PUBKEY)).toBe(3);
  });

  it('revokes one wallet without touching another', async () => {
    await upsertUser(harness.db, OTHER, NOW);
    await revokeSessions(harness.db, PUBKEY);

    expect(await sessionEpoch(harness.db, PUBKEY)).toBe(1);
    expect(await sessionEpoch(harness.db, OTHER)).toBe(0);
  });

  it('counts every one when several land at once', async () => {
    // Incremented in the statement rather than read and written back, so two
    // simultaneous sign-outs cannot both write the same value and leave one of
    // the sessions they were meant to end still valid.
    await Promise.all(Array.from({ length: 8 }, () => revokeSessions(harness.db, PUBKEY)));
    expect(await sessionEpoch(harness.db, PUBKEY)).toBe(8);
  });

  it('survives the user row being written again', async () => {
    await revokeSessions(harness.db, PUBKEY);
    // Sign-in upserts the user. If that reset the epoch, every revocation
    // would be undone by the next sign-in from anywhere.
    await upsertUser(harness.db, PUBKEY, NOW + 1_000);
    expect(await sessionEpoch(harness.db, PUBKEY)).toBe(1);
  });
});
