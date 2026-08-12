import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import {
  driftHistory,
  isSuspended,
  liftSuspension,
  mostTradedMints,
  recordDrift,
  suspendToken,
  suspendedTokens,
  type DriftObservation,
} from '../src/drift';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const NOW = 1_700_000_000_000;

let db: Client;

function observation(overrides: Partial<DriftObservation> = {}): DriftObservation {
  return {
    mint: MINT,
    engineVersion: 1,
    samples: 40,
    medianSignedBps: 0,
    medianAbsBps: 0,
    generousSamples: 0,
    severity: 'ok',
    ...overrides,
  };
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('drift observations', () => {
  it('records and reads back', async () => {
    await recordDrift(db, [observation({ medianSignedBps: 12, severity: 'exploitable' })], NOW);
    const history = await driftHistory(db, MINT);

    expect(history).toHaveLength(1);
    expect(history[0]!.medianSignedBps).toBe(12);
    expect(history[0]!.severity).toBe('exploitable');
  });

  it('keeps the sign', async () => {
    // Negative means the engine short-changed the trader; positive means it
    // paid them too much. Storing this unsigned would erase the only thing
    // that distinguishes a bug from an exploit.
    await recordDrift(db, [observation({ medianSignedBps: -40, medianAbsBps: 40 })], NOW);
    expect((await driftHistory(db, MINT))[0]!.medianSignedBps).toBe(-40);
  });

  it('keeps history rather than a single current value', async () => {
    // After an incident the question is when it started, which a gauge showing
    // only the present cannot answer.
    await recordDrift(db, [observation()], NOW);
    await recordDrift(db, [observation({ severity: 'watch' })], NOW + 1_000);
    await recordDrift(db, [observation({ severity: 'exploitable' })], NOW + 2_000);

    const history = await driftHistory(db, MINT);
    expect(history).toHaveLength(3);
    expect(history[0]!.severity).toBe('exploitable');
    expect(history[2]!.severity).toBe('ok');
  });

  it('writes a batch in one go', async () => {
    await recordDrift(
      db,
      [observation({ mint: 'a' }), observation({ mint: 'b' })],
      NOW,
    );
    expect(await driftHistory(db, 'a')).toHaveLength(1);
    expect(await driftHistory(db, 'b')).toHaveLength(1);
  });

  it('does nothing for an empty batch', async () => {
    await expect(recordDrift(db, [], NOW)).resolves.toBeUndefined();
  });

  it('records the observation and its suspension in one write', async () => {
    // The whole point of the batch: there is never a committed observation that
    // says a token is farmable without the token being off the board.
    await recordDrift(
      db,
      [observation({ medianSignedBps: 30, severity: 'exploitable' })],
      NOW,
      [{ mint: MINT, reason: 'filled better than chain', severity: 'exploitable' }],
    );
    expect(await isSuspended(db, MINT)).toBe(true);
    expect((await driftHistory(db, MINT))[0]!.severity).toBe('exploitable');
  });

  it('rejects an unknown severity', async () => {
    await expect(
      db.execute({
        sql: `INSERT INTO drift_observations
                (mint, engine_version, samples, median_signed_bps, median_abs_bps,
                 generous_samples, severity, observed_at)
              VALUES (?, 1, 1, 0, 0, 0, 'catastrophic', ?)`,
        args: [MINT, NOW],
      }),
    ).rejects.toThrow();
  });
});

describe('suspension', () => {
  it('bars a token from ranked trading', async () => {
    await suspendToken(db, MINT, 'simulator filling better than chain', 'exploitable', NOW);
    expect(await isSuspended(db, MINT)).toBe(true);
    expect(await suspendedTokens(db)).toEqual([MINT]);
  });

  it('reports an unsuspended token as clear', async () => {
    expect(await isSuspended(db, 'other')).toBe(false);
  });

  it('is idempotent', async () => {
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW);
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW + 5_000);
    expect(await suspendedTokens(db)).toHaveLength(1);
  });

  it('keeps the moment it first became farmable', async () => {
    // Refreshing this on every monitoring pass would erase exactly the fact
    // an investigation needs: when the trades stopped being trustworthy.
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW);
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW + 60_000);

    const result = await db.execute({
      sql: 'SELECT suspended_at FROM suspended_tokens WHERE mint = ?',
      args: [MINT],
    });
    expect(Number(result.rows[0]!['suspended_at'])).toBe(NOW);
  });

  it('can be lifted deliberately', async () => {
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW);
    await liftSuspension(db, MINT, 'engine fixed in v2, re-validated', NOW + 10_000);

    expect(await isSuspended(db, MINT)).toBe(false);
    expect(await suspendedTokens(db)).toEqual([]);
  });

  it('records why a suspension was lifted', async () => {
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW);
    await liftSuspension(db, MINT, 'engine fixed in v2', NOW + 10_000);

    const result = await db.execute({
      sql: 'SELECT lifted_note FROM suspended_tokens WHERE mint = ?',
      args: [MINT],
    });
    expect(String(result.rows[0]!['lifted_note'])).toBe('engine fixed in v2');
  });

  it('restarts the clock if a lifted token is suspended again', async () => {
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW);
    await liftSuspension(db, MINT, 'fixed', NOW + 10_000);
    await suspendToken(db, MINT, 'drifted again', 'exploitable', NOW + 20_000);

    expect(await isSuspended(db, MINT)).toBe(true);
    const result = await db.execute({
      sql: 'SELECT suspended_at, lifted_at FROM suspended_tokens WHERE mint = ?',
      args: [MINT],
    });
    expect(Number(result.rows[0]!['suspended_at'])).toBe(NOW + 20_000);
    expect(result.rows[0]!['lifted_at']).toBeNull();
  });

  it('lifting something already lifted changes nothing', async () => {
    await suspendToken(db, MINT, 'reason', 'exploitable', NOW);
    await liftSuspension(db, MINT, 'first', NOW + 1_000);
    await liftSuspension(db, MINT, 'second', NOW + 2_000);

    const result = await db.execute({
      sql: 'SELECT lifted_note FROM suspended_tokens WHERE mint = ?',
      args: [MINT],
    });
    expect(String(result.rows[0]!['lifted_note'])).toBe('first');
  });
});

describe('choosing what to check', () => {
  const OTHER = '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump';
  const QUIET = 'G6kpwWRSuWtVTbutTSZUvg5QVP7o6Bfs9edE6edTpump';

  async function trade(mint: string, sequence: number, at: number): Promise<void> {
    await db.execute({
      sql: `INSERT INTO trades (account_id, sequence, season_id, user_pubkey, mint, side,
              sol_amount, token_amount, fee, price_impact_bps, partial, pool_source,
              clicked_at_slot, filled_at_slot, latency_ms, engine_version, pool_snapshot_id,
              leaf_hash, created_at)
            VALUES (1, ?, 1, 'u', ?, 'buy', '1000000', '1000', '3000', 5, 0, 'pumpswap',
                    1, 1, 600, 1, 1, ?, ?)`,
      args: [sequence, mint, 'b'.repeat(64), at],
    });
  }

  beforeEach(async () => {
    await db.execute('PRAGMA foreign_keys = OFF');
  });

  it('puts the most traded token first', async () => {
    // Being wrong matters in proportion to how many people it is wrong for.
    await trade(QUIET, 1, NOW);
    await trade(OTHER, 2, NOW);
    await trade(OTHER, 3, NOW);

    expect(await mostTradedMints(db, NOW - 1_000, 10)).toEqual([OTHER, QUIET]);
  });

  it('ignores trades older than the window', async () => {
    await trade(OTHER, 1, NOW - 100_000);
    expect(await mostTradedMints(db, NOW - 1_000, 10)).toEqual([]);
  });

  it('skips a token that is already suspended', async () => {
    // It is refused at the trade route, so re-measuring it every cycle spends
    // the whole budget on the one answer that cannot change anything.
    await trade(OTHER, 1, NOW);
    await trade(QUIET, 2, NOW);
    await suspendToken(db, OTHER, 'farmable', 'exploitable', NOW);

    expect(await mostTradedMints(db, NOW - 1_000, 10)).toEqual([QUIET]);
  });

  it('checks a token again once its suspension is lifted', async () => {
    await trade(OTHER, 1, NOW);
    await suspendToken(db, OTHER, 'farmable', 'exploitable', NOW);
    await liftSuspension(db, OTHER, 'engine corrected', NOW + 1);

    expect(await mostTradedMints(db, NOW - 1_000, 10)).toEqual([OTHER]);
  });

  it('honours the limit, because the budget is RPC calls', async () => {
    await trade(OTHER, 1, NOW);
    await trade(QUIET, 2, NOW);
    expect(await mostTradedMints(db, NOW - 1_000, 1)).toHaveLength(1);
  });
});
