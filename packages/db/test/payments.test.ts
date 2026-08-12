import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  createPaymentIntent,
  ensureFreePlaySeason,
  getPaymentIntent,
  hasEntered,
  openPaymentIntents,
  paymentsFor,
  settlePayment,
  upsertUser,
} from '../src/index';

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TREASURY = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NOW = 1_700_000_000_000;

let harness: TestDatabase;
let seasonId: number;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, NOW);
  await upsertUser(harness.db, OTHER, NOW);
  seasonId = await ensureFreePlaySeason(harness.db, NOW);
});

afterEach(() => harness.cleanup());

function intent(reference: string, userPubkey = PUBKEY) {
  return createPaymentIntent(
    harness.db,
    {
      reference,
      userPubkey,
      seasonId,
      purpose: 'season_entry',
      recipient: TREASURY,
      amount: '50000000',
      expiresAt: NOW + 600_000,
    },
    NOW,
  );
}

describe('intents', () => {
  it('is outstanding until it is paid', async () => {
    await intent('ref-1');

    const stored = await getPaymentIntent(harness.db, 'ref-1');
    expect(stored?.paymentId).toBeNull();
    expect(await openPaymentIntents(harness.db, NOW)).toHaveLength(1);
  });

  it('records the treasury it actually showed the user', async () => {
    // Read back at verification rather than from configuration: if the address
    // is ever rotated, a payment already in flight must still be checked
    // against the one the user was shown.
    expect((await intent('ref-1')).recipient).toBe(TREASURY);
  });

  it('refuses to reuse a reference', async () => {
    await intent('ref-1');
    await expect(intent('ref-1', OTHER)).rejects.toThrow();
  });

  it('drops out of the open list once expired', async () => {
    await intent('ref-1');
    expect(await openPaymentIntents(harness.db, NOW + 600_001)).toHaveLength(0);
  });
});

describe('settling a payment', () => {
  it('records the payment, links the intent and creates the entry', async () => {
    await intent('ref-1');
    const result = await settlePayment(harness.db, {
      reference: 'ref-1',
      txSignature: 'sig-1',
      userPubkey: PUBKEY,
      seasonId,
      purpose: 'season_entry',
      amount: '50000000',
      now: NOW + 5_000,
    });

    expect(result.fresh).toBe(true);
    expect(result.payment.status).toBe('verified');
    expect(result.entryId).not.toBeNull();
    expect(await hasEntered(harness.db, seasonId, PUBKEY)).toBe(true);
    expect((await getPaymentIntent(harness.db, 'ref-1'))?.paymentId).toBe(result.payment.id);
  });

  it('credits one transaction once, however many times it is presented', async () => {
    // The confirmation endpoint is exactly what a nervous user clicks twice.
    await intent('ref-1');
    const first = await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW,
    });
    const second = await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW + 1_000,
    });

    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);
    expect(second.payment.id).toBe(first.payment.id);
    expect(await paymentsFor(harness.db, PUBKEY)).toHaveLength(1);
  });

  it('still returns the entry when the payment was already settled', async () => {
    await intent('ref-1');
    await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW,
    });
    const again = await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW,
    });

    expect(again.entryId).not.toBeNull();
  });

  it('records a second payment from a user already entered', async () => {
    // They do not get a second entry, but a payment that landed on chain is a
    // fact and has to be recorded whatever it bought.
    await intent('ref-1');
    await intent('ref-2');
    await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW,
    });
    const second = await settlePayment(harness.db, {
      reference: 'ref-2', txSignature: 'sig-2', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW + 1_000,
    });

    expect(second.fresh).toBe(true);
    expect(second.entryId).toBeNull();
    expect(await paymentsFor(harness.db, PUBKEY)).toHaveLength(2);
  });

  it('refuses to record an entry payment whose reference has no intent', async () => {
    // Without an intent the entry INSERT ... SELECT matches nothing, so the
    // payment would be verified while no entry was ever made: paid, not in. That
    // must fail loudly and roll back, not commit a phantom entry payment.
    await expect(
      settlePayment(harness.db, {
        reference: 'never-created', txSignature: 'sig-x', userPubkey: PUBKEY, seasonId,
        purpose: 'season_entry', amount: '50000000', now: NOW,
      }),
    ).rejects.toThrow(/no payment intent/);
    // Nothing left behind: the rollback took the payment row with it.
    expect(await paymentsFor(harness.db, PUBKEY)).toHaveLength(0);
  });

  it('keeps two users apart', async () => {
    await intent('ref-1', PUBKEY);
    await intent('ref-2', OTHER);
    await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW,
    });

    expect(await hasEntered(harness.db, seasonId, PUBKEY)).toBe(true);
    expect(await hasEntered(harness.db, seasonId, OTHER)).toBe(false);
  });

  it('leaves an unrelated intent outstanding', async () => {
    await intent('ref-1');
    await intent('ref-2');
    await settlePayment(harness.db, {
      reference: 'ref-1', txSignature: 'sig-1', userPubkey: PUBKEY, seasonId,
      purpose: 'season_entry', amount: '50000000', now: NOW,
    });

    expect(await openPaymentIntents(harness.db, NOW)).toHaveLength(1);
  });
});
