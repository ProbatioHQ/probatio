import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  createRankedSeason,
  currentRankedSeason,
  ensureAccount,
  ensureFreePlaySeason,
  highestRankedOrdinal,
  createPaymentIntent,
  openRankedSeason,
  seasonByOrdinal,
  seasonTotals,
  settlePayment,
  upsertUser,
} from '../src/index';

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const START = 1_700_000_000_000;
const DAY = 86_400_000;

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, START);
  await upsertUser(harness.db, OTHER, START);
});

afterEach(() => harness.cleanup());

async function openSeason(ordinal = 1, startsAt = START): Promise<number> {
  const rules = rulesetFor(ordinal);
  const schedule = scheduleFrom(startsAt, rules.durationMs, rules.entryWindowMs);
  return createRankedSeason(
    harness.db,
    {
      ordinal,
      name: `Season ${ordinal}`,
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
    startsAt,
  );
}

describe('creating a ranked season', () => {
  it('records the ruleset hash before anybody enters', async () => {
    await openSeason(1);
    const season = await seasonByOrdinal(harness.db, 1);

    expect(season?.ranked).toBe(true);
    expect(season?.entryCost).toBe('50000000');
    expect(season?.startingBalance).toBe('10000000000');
    expect(season?.rulesetHash).toBe(rulesetHashHex(rulesetFor(1)));
  });

  it('keeps the hash it was created with, whatever the code says later', async () => {
    // The season a trader entered published a hash. If reading it recomputed
    // from current code, editing the rules would silently rewrite what a
    // running season promised — the exact thing the hash exists to prevent.
    await openSeason(1);
    await harness.db.execute({
      sql: 'UPDATE seasons SET scoring_formula_hash = ? WHERE ordinal = 1',
      args: ['a'.repeat(64)],
    });

    expect((await seasonByOrdinal(harness.db, 1))?.rulesetHash).toBe('a'.repeat(64));
  });

  it('gives entrants the season starting balance, not free play money', async () => {
    const seasonId = await openSeason(1);
    const account = await ensureAccount(harness.db, seasonId, PUBKEY, START);
    expect(account.startingBalance).toBe('10000000000');
  });

  it('carries the season simulation conditions onto the account', async () => {
    // A result is only reproducible against the conditions it was produced
    // under, so they follow the account rather than being read from config.
    const seasonId = await openSeason(1);
    const account = await ensureAccount(harness.db, seasonId, PUBKEY, START);

    expect(account.latencyMs).toBe(600);
    expect(account.maxPriceImpactBps).toBe(5_000);
  });

  it('refuses a second season with the same ordinal', async () => {
    await openSeason(1);
    await expect(openSeason(1)).rejects.toThrow();
  });

  it('reports the highest ordinal so far', async () => {
    expect(await highestRankedOrdinal(harness.db)).toBe(0);
    await openSeason(1);
    await openSeason(2, START + 7 * DAY);
    expect(await highestRankedOrdinal(harness.db)).toBe(2);
  });

  it('does not count free play as a ranked season', async () => {
    await ensureFreePlaySeason(harness.db, START);
    expect(await highestRankedOrdinal(harness.db)).toBe(0);
    expect(await currentRankedSeason(harness.db, START)).toBeNull();
  });
});

describe('the entry window', () => {
  it('is open on the first day', async () => {
    await openSeason(1);
    expect((await openRankedSeason(harness.db, START + DAY))?.ordinal).toBe(1);
  });

  it('is shut before the season starts', async () => {
    await openSeason(1);
    expect(await openRankedSeason(harness.db, START - 1)).toBeNull();
  });

  it('is shut after 48 hours even though the season runs on', async () => {
    await openSeason(1);
    expect(await openRankedSeason(harness.db, START + 3 * DAY)).toBeNull();
  });

  it('does not depend on a stored status ever being advanced', async () => {
    // Seasons are written as 'pending' and nothing updates that column. If
    // entry depended on it, no season would ever sell a ticket, and the
    // failure would be silent.
    await openSeason(1);
    const season = await seasonByOrdinal(harness.db, 1);
    expect(season?.status).toBe('pending');
    expect(await openRankedSeason(harness.db, START + DAY)).not.toBeNull();
  });

  it('offers the newest season when two overlap', async () => {
    await openSeason(1);
    await openSeason(2, START + DAY);
    expect((await openRankedSeason(harness.db, START + DAY))?.ordinal).toBe(2);
  });
});

describe('finding the season to show somebody', () => {
  it('shows the one that is running', async () => {
    await openSeason(1);
    expect((await currentRankedSeason(harness.db, START + 3 * DAY))?.ordinal).toBe(1);
  });

  it('shows the next one when none is running yet', async () => {
    // Between seasons, a blank page reads as "the competition is over".
    await openSeason(1, START + 10 * DAY);
    expect((await currentRankedSeason(harness.db, START))?.ordinal).toBe(1);
  });

  it('falls back to the last one once they are all over', async () => {
    await openSeason(1);
    expect((await currentRankedSeason(harness.db, START + 99 * DAY))?.ordinal).toBe(1);
  });
});

describe('the pot', () => {
  async function enter(user: string, reference: string, seasonId: number): Promise<void> {
    await createPaymentIntent(
      harness.db,
      {
        reference,
        userPubkey: user,
        seasonId,
        purpose: 'season_entry',
        recipient: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        amount: '50000000',
        expiresAt: START + 600_000,
      },
      START,
    );
    await settlePayment(harness.db, {
      reference,
      txSignature: `sig-${reference}`,
      userPubkey: user,
      seasonId,
      purpose: 'season_entry',
      amount: '50000000',
      now: START,
    });
  }

  it('is empty before anybody enters', async () => {
    const seasonId = await openSeason(1);
    expect(await seasonTotals(harness.db, seasonId)).toEqual({
      entrants: 0,
      potLamports: 0n,
      entriesLamports: 0n,
      sponsorLamports: 0n,
    });
  });

  it('grows with each verified entry', async () => {
    const seasonId = await openSeason(1);
    await enter(PUBKEY, 'ref-1', seasonId);
    await enter(OTHER, 'ref-2', seasonId);

    expect(await seasonTotals(harness.db, seasonId)).toEqual({
      entrants: 2,
      potLamports: 100_000_000n,
      entriesLamports: 100_000_000n,
      sponsorLamports: 0n,
    });
  });

  it('is summed from verified payments, not counted', async () => {
    // A counter is a second source of truth that drifts the first time an
    // increment is missed. This one decides what people are paid.
    const seasonId = await openSeason(1);
    await enter(PUBKEY, 'ref-1', seasonId);

    await harness.db.execute({
      sql: `INSERT INTO payments (user_pubkey, season_id, purpose, amount, tx_signature, status, created_at)
            VALUES (?, ?, 'season_entry', '50000000', 'unverified-sig', 'pending', ?)`,
      args: [OTHER, seasonId, START],
    });

    // Pending money is not in the pot.
    const totals = await seasonTotals(harness.db, seasonId);
    expect(totals.potLamports).toBe(50_000_000n);
  });

  it('keeps the pots of two seasons apart', async () => {
    const first = await openSeason(1);
    const second = await openSeason(2, START + 7 * DAY);
    await enter(PUBKEY, 'ref-1', first);

    expect((await seasonTotals(harness.db, second)).potLamports).toBe(0n);
  });
});
