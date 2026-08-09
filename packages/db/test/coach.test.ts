import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  coachReportHistory,
  ensureAccount,
  ensureFreePlaySeason,
  latestCoachReport,
  recordCoachReport,
  upsertUser,
  type CoachReportWrite,
} from '../src/index';

const PUBKEY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const NOW = 1_700_000_000_000;

let harness: TestDatabase;
let accountId: number;

beforeEach(async () => {
  harness = await createTestDatabase();
  await upsertUser(harness.db, PUBKEY, NOW);
  const seasonId = await ensureFreePlaySeason(harness.db, NOW);
  accountId = (await ensureAccount(harness.db, seasonId, PUBKEY, NOW)).id;
});

afterEach(() => harness.cleanup());

function write(overrides: Partial<CoachReportWrite> = {}): CoachReportWrite {
  return {
    accountId,
    seasonId: null,
    userPubkey: PUBKEY,
    kind: 'session',
    periodStart: NOW - 3_600_000,
    periodEnd: NOW,
    facts: [{ key: 'exitEfficiencyBps', label: 'Exit timing', value: '22.0%' }],
    tripsAtReport: 10,
    headline: 'You exit too early.',
    focus: 'Hold winners longer.',
    observations: [{ metric: 'exitEfficiencyBps', text: 'You sell near the low of the range.' }],
    model: 'claude-sonnet-5',
    inputTokens: 400,
    outputTokens: 120,
    dropped: 0,
    ...overrides,
  };
}

describe('storing a report', () => {
  it('keeps the facts the model was shown beside what it wrote', async () => {
    // This is what makes a report auditable. Without the inputs, the wording
    // can only be checked against whatever the numbers say today.
    const stored = await recordCoachReport(harness.db, write(), NOW);
    expect(stored?.facts).toEqual([
      { key: 'exitEfficiencyBps', label: 'Exit timing', value: '22.0%' },
    ]);
  });

  it('round trips everything it was given', async () => {
    const stored = await recordCoachReport(harness.db, write(), NOW);

    expect(stored?.headline).toBe('You exit too early.');
    expect(stored?.observations).toEqual([
      { metric: 'exitEfficiencyBps', text: 'You sell near the low of the range.' },
    ]);
    expect(stored?.inputTokens).toBe(400);
    expect(stored?.createdAt).toBe(NOW);
  });

  it('returns the newest one', async () => {
    await recordCoachReport(harness.db, write({ tripsAtReport: 10, headline: 'First.' }), NOW);
    await recordCoachReport(
      harness.db,
      write({ tripsAtReport: 20, headline: 'Second.' }),
      NOW + 1_000,
    );

    expect((await latestCoachReport(harness.db, accountId))?.headline).toBe('Second.');
  });

  it('has no report for an account that has never had one', async () => {
    expect(await latestCoachReport(harness.db, accountId)).toBeNull();
  });

  it('lists history newest first', async () => {
    await recordCoachReport(harness.db, write({ tripsAtReport: 10 }), NOW);
    await recordCoachReport(harness.db, write({ tripsAtReport: 20 }), NOW + 1_000);
    await recordCoachReport(harness.db, write({ tripsAtReport: 30 }), NOW + 2_000);

    const history = await coachReportHistory(harness.db, accountId);
    expect(history.map((report) => report.tripsAtReport)).toEqual([30, 20, 10]);
  });
});

describe('not paying twice for the same report', () => {
  it('refuses a second report at the same trade count', async () => {
    // Two requests arriving together both pass an in-process entitlement
    // check. Only one can win here.
    const first = await recordCoachReport(harness.db, write({ tripsAtReport: 10 }), NOW);
    const second = await recordCoachReport(harness.db, write({ tripsAtReport: 10 }), NOW + 5);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await coachReportHistory(harness.db, accountId)).toHaveLength(1);
  });

  it('allows one once the trade count has moved', async () => {
    await recordCoachReport(harness.db, write({ tripsAtReport: 10 }), NOW);
    expect(await recordCoachReport(harness.db, write({ tripsAtReport: 11 }), NOW + 5)).not.toBeNull();
  });

  it('keeps two accounts apart', async () => {
    const other = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    await upsertUser(harness.db, other, NOW);
    const seasonId = await ensureFreePlaySeason(harness.db, NOW);
    const otherAccount = await ensureAccount(harness.db, seasonId, other, NOW);

    await recordCoachReport(harness.db, write({ tripsAtReport: 10 }), NOW);
    const theirs = await recordCoachReport(
      harness.db,
      write({ accountId: otherAccount.id, userPubkey: other, tripsAtReport: 10 }),
      NOW,
    );

    expect(theirs).not.toBeNull();
  });
});

describe('a report whose body cannot be read', () => {
  it('still counts as a report that happened', async () => {
    // The timestamp is what the entitlement rule depends on. Losing the row
    // over unreadable JSON would hand out a free extra call.
    await recordCoachReport(harness.db, write(), NOW);
    await harness.db.execute({
      sql: 'UPDATE reports SET body = ? WHERE account_id = ?',
      args: ['not json', accountId],
    });

    const stored = await latestCoachReport(harness.db, accountId);
    expect(stored).not.toBeNull();
    expect(stored?.observations).toEqual([]);
    expect(stored?.createdAt).toBe(NOW);
  });
});
