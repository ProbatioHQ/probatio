import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  createRankedSeason,
  enterFreeSeason,
  entriesFromFunder,
  hasEntered,
  openRankedSeason,
  seasonTotals,
  upsertUser,
} from '../src/index';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const C = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FUNDER = 'So11111111111111111111111111111111111111112';
const START = 1_700_000_000_000;
const SOL = 1_000_000_000n;

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  for (const key of [A, B, C]) await upsertUser(harness.db, key, START);
});

afterEach(() => harness.cleanup());

async function seedSeason(entryCost = '0', sponsor = (2n * SOL).toString()): Promise<number> {
  const rules = rulesetFor(1);
  const schedule = scheduleFrom(START, rules.durationMs, rules.entryWindowMs);
  return createRankedSeason(
    harness.db,
    {
      ordinal: 0,
      name: 'Season 0',
      startsAt: schedule.startsAt,
      endsAt: schedule.endsAt,
      entryClosesAt: schedule.entryClosesAt,
      startingBalance: rules.startingBalance.toString(),
      entryCost,
      houseBps: rules.houseBps,
      houseThreshold: rules.houseThreshold.toString(),
      latencyMs: rules.latencyMs,
      maxPriceImpactBps: rules.maxPriceImpactBps,
      engineVersion: rules.engineVersion,
      rulesetHash: rulesetHashHex(rules),
      sponsorLamports: sponsor,
    },
    START,
  );
}

function evidence(funder: string | null = FUNDER, flags: string[] = []) {
  return { funder, walletFirstSeenAt: START - 86_400_000, walletSignatureCount: 300, flags };
}

describe('a season that costs nothing to enter', () => {
  it('is open for entry like any other', async () => {
    const id = await seedSeason();
    const open = await openRankedSeason(harness.db, START + 3_600_000);
    expect(open?.id).toBe(id);
    expect(open?.entryCost).toBe('0');
  });

  it('lets a trader in without a payment', async () => {
    const seasonId = await seedSeason();
    const result = await enterFreeSeason(harness.db, {
      seasonId,
      userPubkey: A,
      evidence: evidence(),
      now: START,
    });

    expect(result.entryId).not.toBeNull();
    expect(result.alreadyEntered).toBe(false);
    expect(await hasEntered(harness.db, seasonId, A)).toBe(true);
  });

  it('records the entry with no payment attached', async () => {
    // Not a payment of zero. There was no transaction, and inventing one to
    // satisfy the schema would put a fiction in the ledger.
    const seasonId = await seedSeason();
    await enterFreeSeason(harness.db, { seasonId, userPubkey: A, evidence: evidence(), now: START });

    const row = await harness.db.execute({
      sql: 'SELECT payment_id FROM entries WHERE season_id = ? AND user_pubkey = ?',
      args: [seasonId, A],
    });
    expect(row.rows[0]!['payment_id']).toBeNull();
  });

  it('is idempotent', async () => {
    const seasonId = await seedSeason();
    const first = await enterFreeSeason(harness.db, { seasonId, userPubkey: A, evidence: evidence(), now: START });
    const second = await enterFreeSeason(harness.db, { seasonId, userPubkey: A, evidence: evidence(), now: START });

    expect(second.alreadyEntered).toBe(true);
    expect(second.entryId).toBe(first.entryId);
  });

  it('still records the wallet evidence', async () => {
    // It matters more here than anywhere: with no entry cost, the funding
    // limit is the only thing between one person and fifty entries.
    const seasonId = await seedSeason();
    await enterFreeSeason(harness.db, {
      seasonId,
      userPubkey: A,
      evidence: evidence(FUNDER, ['young_wallet']),
      now: START,
    });

    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, START)).toBe(1);
  });

  it('counts free entries toward the funder limit', async () => {
    const seasonId = await seedSeason();
    for (const trader of [A, B, C]) {
      await enterFreeSeason(harness.db, { seasonId, userPubkey: trader, evidence: evidence(), now: START });
    }
    expect(await entriesFromFunder(harness.db, seasonId, FUNDER, START)).toBe(3);
  });
});

describe('a sponsored prize', () => {
  it('is the pot even though nobody paid in', async () => {
    const seasonId = await seedSeason();
    await enterFreeSeason(harness.db, { seasonId, userPubkey: A, evidence: evidence(), now: START });

    const totals = await seasonTotals(harness.db, seasonId);
    expect(totals.potLamports).toBe(2n * SOL);
    expect(totals.entriesLamports).toBe(0n);
    expect(totals.sponsorLamports).toBe(2n * SOL);
    expect(totals.entrants).toBe(1);
  });

  it('is kept apart from what entrants paid', async () => {
    // They mean different things when a season voids: entries are owed back,
    // a sponsored prize was never theirs.
    const seasonId = await seedSeason('0', SOL.toString());
    const totals = await seasonTotals(harness.db, seasonId);

    expect(totals.entriesLamports).toBe(0n);
    expect(totals.sponsorLamports).toBe(SOL);
  });

  it('defaults to nothing for an ordinary season', async () => {
    const rules = rulesetFor(1);
    const schedule = scheduleFrom(START, rules.durationMs, rules.entryWindowMs);
    const id = await createRankedSeason(
      harness.db,
      {
        ordinal: 1,
        name: 'Season 1',
        startsAt: schedule.startsAt,
        endsAt: schedule.endsAt,
        entryClosesAt: schedule.entryClosesAt,
        startingBalance: rules.startingBalance.toString(),
        entryCost: rules.entryCost.toString(),
        houseBps: rules.houseBps,
        houseThreshold: rules.houseThreshold.toString(),
        latencyMs: rules.latencyMs,
        maxPriceImpactBps: rules.maxPriceImpactBps,
        engineVersion: rules.engineVersion,
        rulesetHash: rulesetHashHex(rules),
      },
      START,
    );

    expect((await seasonTotals(harness.db, id)).sponsorLamports).toBe(0n);
  });
});
