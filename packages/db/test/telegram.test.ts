import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { claimUpdate, pruneUpdates } from '../src/index';

/**
 * Handling each Telegram update exactly once.
 *
 * Telegram redelivers until the webhook answers, and redelivers again if the
 * answer was slow or lost. That is correct of them and dangerous here: a
 * retried update is a second trade, the same tap filled twice, on an account
 * whose whole value is that its record is exact.
 */

const NOW = 1_800_000_000_000;

let harness: TestDatabase;
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(() => harness.cleanup());

describe('claiming an update', () => {
  it('is claimed once and refused after that', async () => {
    expect(await claimUpdate(harness.db, 5001, NOW)).toBe(true);
    expect(await claimUpdate(harness.db, 5001, NOW + 900)).toBe(false);
  });

  /*
   * The claim is the insert rather than a read, so two deliveries arriving
   * together race the primary key instead of each other. A select-then-insert
   * would let both see nothing and both proceed.
   */
  it('lets exactly one of two simultaneous deliveries through', async () => {
    const [a, b] = await Promise.all([
      claimUpdate(harness.db, 6001, NOW),
      claimUpdate(harness.db, 6001, NOW),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('keeps different updates apart', async () => {
    expect(await claimUpdate(harness.db, 1, NOW)).toBe(true);
    expect(await claimUpdate(harness.db, 2, NOW)).toBe(true);
  });

  /* Telegram gives up long before a day, so older rows only take space. */
  it('forgets what can no longer be retried', async () => {
    await claimUpdate(harness.db, 7001, NOW - 48 * 60 * 60 * 1_000);
    await claimUpdate(harness.db, 7002, NOW);

    expect(await pruneUpdates(harness.db, NOW)).toBe(1);
    // The recent one is still claimed, so a retry of it is still refused.
    expect(await claimUpdate(harness.db, 7002, NOW)).toBe(false);
  });
});
