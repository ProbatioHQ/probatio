import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { CODE_TTL_MS, claimLinkCode, issueLinkCode, linkedTelegram, linkedWallet, unlinkTelegram, upsertUser } from '../src/index';

/**
 * Connecting a Telegram account to a wallet.
 *
 * Telegram knows who is typing and has no idea which wallet they own, so the
 * link has to be proved on the site with a signature. The code only exists to
 * survive the walk from one to the other, and everything here is about it not
 * being worth stealing, guessing, or reusing.
 */

const ALICE = '11111111111111111111111111111111';
const BOB = 'So11111111111111111111111111111111111111112';
const NOW = 1_800_000_000_000;

let harness: TestDatabase;
beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, ALICE, NOW);
  await upsertUser(harness.db, BOB, NOW);
});
afterEach(() => harness.cleanup());

describe('linking an account', () => {
  it('links the wallet that redeems the code', async () => {
    const { code } = await issueLinkCode(harness.db, 500, -100, NOW);
    const outcome = await claimLinkCode(harness.db, code, ALICE, NOW + 1_000);

    expect(outcome).toMatchObject({ status: 'linked', telegramUserId: 500, chatId: -100 });
    expect(await linkedWallet(harness.db, 500)).toBe(ALICE);
    expect(await linkedTelegram(harness.db, ALICE)).toBe(500);
  });

  it('reads a code however it was typed back', async () => {
    const { code } = await issueLinkCode(harness.db, 501, -1, NOW);
    const outcome = await claimLinkCode(harness.db, ` ${code.toLowerCase()} `, ALICE, NOW);
    expect(outcome.status).toBe('linked');
  });

  it('spends a code exactly once', async () => {
    const { code } = await issueLinkCode(harness.db, 502, -1, NOW);
    expect((await claimLinkCode(harness.db, code, ALICE, NOW)).status).toBe('linked');
    expect((await claimLinkCode(harness.db, code, BOB, NOW)).status).toBe('used');
  });

  it('refuses a code that has gone stale', async () => {
    const { code } = await issueLinkCode(harness.db, 503, -1, NOW);
    expect((await claimLinkCode(harness.db, code, ALICE, NOW + CODE_TTL_MS + 1)).status).toBe(
      'expired',
    );
  });

  it('says so when the code is not a code', async () => {
    expect((await claimLinkCode(harness.db, 'ZZZZZZZZ', ALICE, NOW)).status).toBe('unknown');
  });

  /*
   * Typing /link twice because the first message scrolled away should not leave
   * a live code behind. The newest is the only one anybody can see.
   */
  it('retires the previous code when a new one is issued', async () => {
    const first = await issueLinkCode(harness.db, 504, -1, NOW);
    const second = await issueLinkCode(harness.db, 504, -1, NOW + 5_000);

    expect((await claimLinkCode(harness.db, first.code, ALICE, NOW + 6_000)).status).toBe('unknown');
    expect((await claimLinkCode(harness.db, second.code, ALICE, NOW + 6_000)).status).toBe('linked');
  });

  /*
   * Two people pointing at one wallet would mean two people trading one
   * balance. The two directions are refused separately because they are
   * different problems and send somebody somewhere different.
   */
  it('will not attach one wallet to a second Telegram account', async () => {
    await claimLinkCode(harness.db, (await issueLinkCode(harness.db, 505, -1, NOW)).code, ALICE, NOW);

    const other = await issueLinkCode(harness.db, 606, -1, NOW);
    expect((await claimLinkCode(harness.db, other.code, ALICE, NOW)).status).toBe('wallet_taken');
  });

  it('will not attach a second wallet to one Telegram account', async () => {
    await claimLinkCode(harness.db, (await issueLinkCode(harness.db, 507, -1, NOW)).code, ALICE, NOW);

    const again = await issueLinkCode(harness.db, 507, -1, NOW);
    expect((await claimLinkCode(harness.db, again.code, BOB, NOW)).status).toBe('telegram_taken');
  });

  /* Re-linking the same pair is somebody redoing it, not a conflict. */
  it('lets the same pair link again', async () => {
    await claimLinkCode(harness.db, (await issueLinkCode(harness.db, 508, -1, NOW)).code, ALICE, NOW);
    const again = await issueLinkCode(harness.db, 508, -1, NOW);
    expect((await claimLinkCode(harness.db, again.code, ALICE, NOW)).status).toBe('linked');
  });

  it('disconnects without touching anything else', async () => {
    await claimLinkCode(harness.db, (await issueLinkCode(harness.db, 509, -1, NOW)).code, ALICE, NOW);

    expect(await unlinkTelegram(harness.db, ALICE)).toBe(true);
    expect(await linkedWallet(harness.db, 509)).toBeNull();
    // And the wallet is free to link again afterwards.
    const fresh = await issueLinkCode(harness.db, 510, -1, NOW);
    expect((await claimLinkCode(harness.db, fresh.code, ALICE, NOW)).status).toBe('linked');
  });

  /*
   * Two browsers redeeming the same code at once. The spend is a conditional
   * update inside the transaction, so one of them finds nothing to update.
   */
  it('lets exactly one of two simultaneous claims through', async () => {
    const { code } = await issueLinkCode(harness.db, 511, -1, NOW);
    const [a, b] = await Promise.all([
      claimLinkCode(harness.db, code, ALICE, NOW),
      claimLinkCode(harness.db, code, ALICE, NOW),
    ]);
    expect([a.status, b.status].filter((s) => s === 'linked')).toHaveLength(1);
  });
});
