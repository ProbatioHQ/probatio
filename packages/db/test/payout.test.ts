import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  claimData,
  entryPayoutSignature,
  markEntryClaimed,
  markEntryRefunded,
  markSeasonFinalized,
  markSeasonVoided,
  recordFinalization,
  recordOnChainEntry,
  recordPayout,
  setSeasonOnchain,
} from '../src/payout';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const SEASON_ADDR = 'HRGEAiqX4qw7B1fgNsR64oRAKF4QwkjkZFx9YXDFxaXA';
const EVIDENCE = { funder: null, walletFirstSeenAt: null, walletSignatureCount: null, flags: [] };

let test: TestDatabase;

beforeEach(async () => {
  test = await createTestDatabase();
  await test.db.execute({ sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?)', args: [TRADER, 1] });
});
afterEach(() => {
  test.cleanup();
});

async function makeSeason(entryCost = '50000000'): Promise<number> {
  const result = await test.db.execute({
    sql: `INSERT INTO seasons (ordinal, name, ranked, status, starting_balance, entry_cost,
            house_bps, house_threshold, latency_ms, max_price_impact_bps, engine_version,
            scoring_formula_hash, created_at)
          VALUES (1, 'Season 1', 1, 'running', '10000000000', ?, 1000, '0', 600, 5000, 1, ?, 1)
          RETURNING id`,
    args: [entryCost, 'a'.repeat(64)],
  });
  return Number(result.rows[0]!['id']);
}

describe('payout db', () => {
  it('records an on-chain entry and reads it back', async () => {
    const seasonId = await makeSeason();
    await recordOnChainEntry(test.db, {
      seasonId,
      userPubkey: TRADER,
      onchainEntryPubkey: SEASON_ADDR,
      entryTxSignature: 'sig1',
      paid: 50_000_000n,
      evidence: EVIDENCE,
      now: 10,
    });
    const data = await claimData(test.db, { seasonId, trader: TRADER });
    expect(data).not.toBeNull();
    expect(data!.resultsRoot).toBeNull(); // not finalized yet
    expect(data!.payoutLamports).toBeNull();
  });

  it('finalizes a season and freezes each winner result + proof', async () => {
    const seasonId = await makeSeason();
    await recordOnChainEntry(test.db, {
      seasonId, userPubkey: TRADER, onchainEntryPubkey: SEASON_ADDR,
      entryTxSignature: 'sig1', paid: 50_000_000n, evidence: EVIDENCE, now: 10,
    });
    await setSeasonOnchain(test.db, { seasonId, onchainPubkey: SEASON_ADDR });
    await recordFinalization(test.db, {
      seasonId,
      resultsRoot: 'b'.repeat(64),
      now: 100,
      rows: [
        {
          trader: TRADER,
          rank: 1,
          startingBalance: 10_000_000_000n,
          finalEquity: 15_000_000_000n,
          returnBps: 5000,
          tradeCount: 4,
          payoutLamports: 135_000_000n,
          proof: [{ sibling: 'c'.repeat(64), siblingOnLeft: true }],
        },
      ],
    });

    const data = await claimData(test.db, { seasonId, trader: TRADER });
    expect(data!.resultsRoot).toBe('b'.repeat(64));
    expect(data!.rank).toBe(1);
    expect(data!.startingBalance).toBe(10_000_000_000n);
    expect(data!.finalEquity).toBe(15_000_000_000n);
    expect(data!.returnBps).toBe(5000);
    expect(data!.payoutLamports).toBe(135_000_000n);
    expect(data!.proof).toEqual([{ sibling: 'c'.repeat(64), siblingOnLeft: true }]);
  });

  it('a negative return round-trips', async () => {
    const seasonId = await makeSeason();
    await recordOnChainEntry(test.db, {
      seasonId, userPubkey: TRADER, onchainEntryPubkey: SEASON_ADDR,
      entryTxSignature: 'sig1', paid: 50_000_000n, evidence: EVIDENCE, now: 10,
    });
    await recordFinalization(test.db, {
      seasonId, resultsRoot: 'd'.repeat(64), now: 100,
      rows: [{ trader: TRADER, rank: 9, startingBalance: 10n, finalEquity: 4n, returnBps: -6000, tradeCount: 2, payoutLamports: 0n, proof: [] }],
    });
    const data = await claimData(test.db, { seasonId, trader: TRADER });
    expect(data!.returnBps).toBe(-6000);
    expect(data!.payoutLamports).toBe(0n);
  });

  it('marks a prize claimed once and refuses a second claim or a refund after', async () => {
    const seasonId = await makeSeason();
    await recordOnChainEntry(test.db, {
      seasonId, userPubkey: TRADER, onchainEntryPubkey: SEASON_ADDR,
      entryTxSignature: 'sig1', paid: 50_000_000n, evidence: EVIDENCE, now: 10,
    });
    expect(await markEntryClaimed(test.db, { seasonId, trader: TRADER, txSignature: 'claim', now: 200 })).toBe(true);
    expect(await markEntryClaimed(test.db, { seasonId, trader: TRADER, txSignature: 'claim2', now: 201 })).toBe(false);
    expect(await markEntryRefunded(test.db, { seasonId, trader: TRADER, txSignature: 'refund', now: 202 })).toBe(false);
    const data = await claimData(test.db, { seasonId, trader: TRADER });
    expect(data!.claimedAt).toBe(200);
    expect(data!.refundedAt).toBeNull();
  });

  it('voids a season and refunds an entry once', async () => {
    const seasonId = await makeSeason();
    await recordOnChainEntry(test.db, {
      seasonId, userPubkey: TRADER, onchainEntryPubkey: SEASON_ADDR,
      entryTxSignature: 'sig1', paid: 50_000_000n, evidence: EVIDENCE, now: 10,
    });
    await markSeasonVoided(test.db, { seasonId, now: 300 });
    expect(await markEntryRefunded(test.db, { seasonId, trader: TRADER, txSignature: 'refund', now: 301 })).toBe(true);
    expect(await markEntryRefunded(test.db, { seasonId, trader: TRADER, txSignature: 'refund2', now: 302 })).toBe(false);
    const data = await claimData(test.db, { seasonId, trader: TRADER });
    expect(data!.voided).toBe(true);
    expect(data!.refundedAt).toBe(301);
  });

  it('pays a winner once and will not pay them twice', async () => {
    const seasonId = await makeSeason();
    await recordOnChainEntry(test.db, {
      seasonId, userPubkey: TRADER, onchainEntryPubkey: SEASON_ADDR,
      entryTxSignature: 'sig1', paid: 50_000_000n, evidence: EVIDENCE, now: 10,
    });
    expect(await entryPayoutSignature(test.db, { seasonId, trader: TRADER })).toBeNull();

    await recordPayout(test.db, { seasonId, trader: TRADER, payout: 135_000_000n, txSignature: 'pay1', now: 100 });
    expect(await entryPayoutSignature(test.db, { seasonId, trader: TRADER })).toBe('pay1');

    // A second payout is refused: the guard keeps the first signature.
    await recordPayout(test.db, { seasonId, trader: TRADER, payout: 999n, txSignature: 'pay2', now: 200 });
    expect(await entryPayoutSignature(test.db, { seasonId, trader: TRADER })).toBe('pay1');

    await markSeasonFinalized(test.db, { seasonId, now: 300 });
    const data = await claimData(test.db, { seasonId, trader: TRADER });
    expect(data!.payoutLamports).toBe(135_000_000n);
  });

  it('has no claim for a trader who never entered', async () => {
    const seasonId = await makeSeason();
    expect(await claimData(test.db, { seasonId, trader: TRADER })).toBeNull();
  });
});
