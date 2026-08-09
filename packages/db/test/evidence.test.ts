import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  createPaymentIntent,
  ensureFreePlaySeason,
  entriesFromFunder,
  recordIntentEvidence,
  seasonEvidence,
  settlePayment,
  upsertUser,
} from '../src/index';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const C = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FUNDER = 'So11111111111111111111111111111111111111112';
const TREASURY = 'Vote111111111111111111111111111111111111111';
const NOW = 1_700_000_000_000;

let harness: TestDatabase;
let seasonId: number;

beforeEach(async () => {
  harness = await createTestDatabase();
  for (const key of [A, B, C]) await upsertUser(harness.db, key, NOW);
  seasonId = await ensureFreePlaySeason(harness.db, NOW);
});

afterEach(() => harness.cleanup());

async function intent(
  user: string,
  reference: string,
  funder: string | null,
  flags: string[] = [],
): Promise<void> {
  await createPaymentIntent(
    harness.db,
    {
      reference,
      userPubkey: user,
      seasonId,
      purpose: 'season_entry',
      recipient: TREASURY,
      amount: '50000000',
      expiresAt: NOW + 600_000,
    },
    NOW,
  );
  await recordIntentEvidence(harness.db, reference, {
    funder,
    walletFirstSeenAt: NOW - 86_400_000,
    walletSignatureCount: 42,
    flags,
  });
}

async function settle(user: string, reference: string): Promise<void> {
  await settlePayment(harness.db, {
    reference,
    txSignature: `sig-${reference}`,
    userPubkey: user,
    seasonId,
    purpose: 'season_entry',
    amount: '50000000',
    now: NOW,
  });
}

describe('counting a funding source', () => {
  it('counts nothing for a source nobody used', async () => {
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, NOW)).toBe(0);
  });

  it('counts an outstanding intent, not just a settled entry', async () => {
    // Without this, fifty intents opened in the same second each see no
    // siblings and all pass. The limit would be enforced against nobody.
    await intent(A, 'ref-1', FUNDER);
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, NOW)).toBe(1);
  });

  it('does not double count an intent that became an entry', async () => {
    await intent(A, 'ref-1', FUNDER);
    await settle(A, 'ref-1');
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, NOW)).toBe(1);
  });

  it('counts across several wallets from one source', async () => {
    await intent(A, 'ref-1', FUNDER);
    await intent(B, 'ref-2', FUNDER);
    await intent(C, 'ref-3', FUNDER);
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, NOW)).toBe(3);
  });

  it('lets an abandoned intent expire out of the count', async () => {
    // An abandoned request should not hold a slot against a source forever.
    await intent(A, 'ref-1', FUNDER);
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, NOW + 600_001)).toBe(0);
  });

  it('keeps two funding sources apart', async () => {
    await intent(A, 'ref-1', FUNDER);
    await intent(B, 'ref-2', TREASURY);
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, NOW)).toBe(1);
  });
});

describe('evidence surviving to the entry', () => {
  it('carries the funder and flags across settlement', async () => {
    // Re-gathering at settlement would read a wallet that has had time to
    // change since it was checked.
    await intent(A, 'ref-1', FUNDER, ['young_wallet']);
    await settle(A, 'ref-1');

    const evidence = await seasonEvidence(harness.db, seasonId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.funder).toBe(FUNDER);
    expect(evidence[0]!.flags).toEqual(['young_wallet']);
    expect(evidence[0]!.walletSignatureCount).toBe(42);
  });

  it('records an entry with no funder found', async () => {
    await intent(A, 'ref-1', null);
    await settle(A, 'ref-1');

    const evidence = await seasonEvidence(harness.db, seasonId);
    expect(evidence[0]!.funder).toBeNull();
  });

  it('makes a cluster visible after the fact', async () => {
    // The whole point. When somebody asks whether a record is worth backing,
    // this is the only place the other wallets are still visible.
    await intent(A, 'ref-1', FUNDER, ['shared_funder']);
    await intent(B, 'ref-2', FUNDER, ['shared_funder']);
    await intent(C, 'ref-3', TREASURY);
    await settle(A, 'ref-1');
    await settle(B, 'ref-2');
    await settle(C, 'ref-3');

    const evidence = await seasonEvidence(harness.db, seasonId);
    const byFunder = new Map<string, number>();
    for (const entry of evidence) {
      if (entry.funder) byFunder.set(entry.funder, (byFunder.get(entry.funder) ?? 0) + 1);
    }

    expect(byFunder.get(FUNDER)).toBe(2);
    expect(byFunder.get(TREASURY)).toBe(1);
  });

  it('survives unreadable flags', async () => {
    await intent(A, 'ref-1', FUNDER);
    await settle(A, 'ref-1');
    await harness.db.execute({
      sql: 'UPDATE entries SET evidence_flags = ? WHERE season_id = ?',
      args: ['not json', seasonId],
    });

    const evidence = await seasonEvidence(harness.db, seasonId);
    expect(evidence[0]!.flags).toEqual([]);
    expect(evidence[0]!.funder).toBe(FUNDER);
  });
});
