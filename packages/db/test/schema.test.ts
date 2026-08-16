import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { appliedMigrations, migrate } from '../src/migrate';
import {
  AmountEncodingError,
  decodeAmount,
  decodeSignedAmount,
  encodeAmount,
  encodeSignedAmount,
} from '../src/amount';

const PUBKEY = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let db: Client;

async function seed(): Promise<{ seasonId: number; accountId: number; snapshotId: number }> {
  const now = Date.now();

  await db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?)',
    args: [PUBKEY, now],
  });

  const season = await db.execute({
    sql: `INSERT INTO seasons (
            ordinal, name, ranked, status, starting_balance, entry_cost,
            house_bps, house_threshold,
            latency_ms, max_price_impact_bps, engine_version,
            scoring_formula_hash, created_at
          ) VALUES (1, 'Season 1', 1, 'pending', '10000000000', '50000000',
                    1000, '1000000000', 500, 5000, 1, 'abc123', ?)
          RETURNING id`,
    args: [now],
  });
  const seasonId = Number(season.rows[0]!['id']);

  const account = await db.execute({
    sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
          VALUES (?, ?, '10000000000', ?, ?) RETURNING id`,
    args: [seasonId, PUBKEY, now, now],
  });
  const accountId = Number(account.rows[0]!['id']);

  const snapshot = await db.execute({
    sql: `INSERT INTO pool_snapshots
            (mint, sol_reserve, token_reserve, token_decimals, fee_bps, source, slot, observed_at)
          VALUES (?, '30000000000', '1073000000000000', 6, 100, 'pumpfun-curve', 1000, ?)
          RETURNING id`,
    args: [MINT, now],
  });
  const snapshotId = Number(snapshot.rows[0]!['id']);

  return { seasonId, accountId, snapshotId };
}

async function insertTrade(ids: Awaited<ReturnType<typeof seed>>): Promise<number> {
  const result = await db.execute({
    sql: `INSERT INTO trades (
            account_id, season_id, user_pubkey, mint, side,
            sol_amount, token_amount, fee, price_impact_bps, partial,
            pool_source, clicked_at_slot, filled_at_slot, latency_ms,
            engine_version, pool_snapshot_id, leaf_hash, created_at
          ) VALUES (?, ?, ?, ?, 'buy', '500000000', '17000000000', '5000000',
                    120, 0, 'pumpfun-curve', 1000, 1002, 500, 1, ?, 'deadbeef', ?)
          RETURNING id`,
    args: [ids.accountId, ids.seasonId, PUBKEY, MINT, ids.snapshotId, Date.now()],
  });
  return Number(result.rows[0]!['id']);
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('migrations', () => {
  it('creates every table the plan calls for', async () => {
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const tables = result.rows.map((r) => String(r['name']));

    for (const table of [
      'accounts',
      'commits',
      'entries',
      'payments',
      'pool_snapshots',
      'positions',
      'reports',
      'seasons',
      'trades',
      'users',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('records what it applied', async () => {
    const applied = await appliedMigrations(db);
    expect(applied.map((m) => m.name)).toEqual([
      '001_init.sql',
      '002_auth_nonces.sql',
      '003_token_metadata.sql',
      '004_candles.sql',
      '005_drift.sql',
      '006_commit_intent.sql',
      '007_launches.sql',
      '008_trade_sequence.sql',
      '009_coach_reports.sql',
      '010_payment_intents.sql',
      '011_wallet_evidence.sql',
      '012_display_names.sql',
      '013_availability.sql',
      '014_activity.sql',
      '015_sponsored_prize.sql',
      '016_curve_state.sql',
      '017_curve_virtual_reserves.sql',
      '018_session_epoch.sql',
      '019_practice_purchases.sql',
      '020_snapshot_deliverable_tokens.sql',
      '021_payout_engine.sql',
      '022_reset_chart_history.sql',
      '023_rewalk_full_history.sql',
    ]);
  });

  it('is a no-op the second time', async () => {
    const ran = await migrate(db);
    expect(ran).toEqual([]);
  });
});

describe('users', () => {
  it('has no email column, and cannot grow one by accident', async () => {
    const result = await db.execute('SELECT * FROM pragma_table_info(?)', ['users']);
    const columns = result.rows.map((r) => String(r['name']));

    // Pinned exactly, on purpose. Auth here is a wallet signature and nothing
    // else, and the way that quietly stops being true is a column appearing on
    // this table because some library wanted one. Adding to this list is meant
    // to be a decision, which is why `session_epoch` had to be added by hand.
    expect(columns).toEqual(['pubkey', 'display_name', 'created_at', 'session_epoch']);
    expect(columns).not.toContain('email');
  });
});

describe('trades are append-only', () => {
  it('refuses an update', async () => {
    const ids = await seed();
    const tradeId = await insertTrade(ids);

    await expect(
      db.execute({ sql: 'UPDATE trades SET fee = ? WHERE id = ?', args: ['0', tradeId] }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a delete', async () => {
    const ids = await seed();
    const tradeId = await insertTrade(ids);

    await expect(
      db.execute({ sql: 'DELETE FROM trades WHERE id = ?', args: [tradeId] }),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps the row intact after a refused write', async () => {
    const ids = await seed();
    const tradeId = await insertTrade(ids);

    await expect(
      db.execute({ sql: 'UPDATE trades SET fee = ? WHERE id = ?', args: ['0', tradeId] }),
    ).rejects.toThrow();

    const result = await db.execute({
      sql: 'SELECT fee FROM trades WHERE id = ?',
      args: [tradeId],
    });
    expect(String(result.rows[0]!['fee'])).toBe('5000000');
  });
});

describe('amount columns', () => {
  it('reject a float', async () => {
    const ids = await seed();
    await expect(
      db.execute({
        sql: 'UPDATE accounts SET sol_balance = ? WHERE id = ?',
        args: ['1.5', ids.accountId],
      }),
    ).rejects.toThrow();
  });

  it('reject a negative', async () => {
    const ids = await seed();
    await expect(
      db.execute({
        sql: 'UPDATE accounts SET sol_balance = ? WHERE id = ?',
        args: ['-1', ids.accountId],
      }),
    ).rejects.toThrow();
  });

  it('hold a value larger than a signed 64-bit integer', async () => {
    const ids = await seed();
    // 2^64, which INTEGER could not store and REAL could not store exactly.
    const huge = '18446744073709551616';
    await db.execute({
      sql: 'UPDATE accounts SET sol_balance = ? WHERE id = ?',
      args: [huge, ids.accountId],
    });

    const result = await db.execute({
      sql: 'SELECT sol_balance FROM accounts WHERE id = ?',
      args: [ids.accountId],
    });
    expect(String(result.rows[0]!['sol_balance'])).toBe(huge);
    expect(decodeAmount(String(result.rows[0]!['sol_balance']))).toBe(18446744073709551616n);
  });
});

describe('referential integrity', () => {
  it('rejects a trade against an account that does not exist', async () => {
    const ids = await seed();
    await expect(
      db.execute({
        sql: `INSERT INTO trades (
                account_id, season_id, user_pubkey, mint, side, sol_amount, token_amount,
                fee, price_impact_bps, partial, pool_source, clicked_at_slot, filled_at_slot,
                latency_ms, engine_version, pool_snapshot_id, leaf_hash, created_at
              ) VALUES (999999, ?, ?, ?, 'buy', '1', '1', '0', 0, 0, 'pumpfun-curve',
                        1, 1, 0, 1, ?, 'x', ?)`,
        args: [ids.seasonId, PUBKEY, MINT, ids.snapshotId, Date.now()],
      }),
    ).rejects.toThrow();
  });

  it('allows one entry per user per season and no more', async () => {
    const ids = await seed();
    const now = Date.now();

    await db.execute({
      sql: 'INSERT INTO entries (season_id, user_pubkey, entered_at) VALUES (?, ?, ?)',
      args: [ids.seasonId, PUBKEY, now],
    });

    await expect(
      db.execute({
        sql: 'INSERT INTO entries (season_id, user_pubkey, entered_at) VALUES (?, ?, ?)',
        args: [ids.seasonId, PUBKEY, now],
      }),
    ).rejects.toThrow();
  });

  it('cannot credit the same payment transaction twice', async () => {
    const ids = await seed();
    const now = Date.now();
    const signature = '5x'.repeat(20);

    await db.execute({
      sql: `INSERT INTO payments (user_pubkey, season_id, purpose, amount, tx_signature, status, created_at)
            VALUES (?, ?, 'season_entry', '50000000', ?, 'verified', ?)`,
      args: [PUBKEY, ids.seasonId, signature, now],
    });

    await expect(
      db.execute({
        sql: `INSERT INTO payments (user_pubkey, season_id, purpose, amount, tx_signature, status, created_at)
              VALUES (?, ?, 'season_entry', '50000000', ?, 'verified', ?)`,
        args: [PUBKEY, ids.seasonId, signature, now],
      }),
    ).rejects.toThrow();
  });
});

describe('block P history', () => {
  it('records the per-season figures capital allocation will need', async () => {
    const ids = await seed();
    await db.execute({
      sql: `INSERT INTO entries
              (season_id, user_pubkey, entered_at, trade_count,
               distinct_token_count, score, rank, percentile)
            VALUES (?, ?, ?, 42, 27, '1.83', 3, 0.94)`,
      args: [ids.seasonId, PUBKEY, Date.now()],
    });

    const result = await db.execute({
      sql: 'SELECT trade_count, distinct_token_count, percentile FROM entries WHERE season_id = ?',
      args: [ids.seasonId],
    });
    const row = result.rows[0]!;
    expect(Number(row['trade_count'])).toBe(42);
    expect(Number(row['distinct_token_count'])).toBe(27);
    expect(Number(row['percentile'])).toBeCloseTo(0.94);
  });
});

describe('amount encoding', () => {
  it('round-trips', () => {
    expect(decodeAmount(encodeAmount(10_000_000_000n))).toBe(10_000_000_000n);
  });

  it('refuses to encode a negative amount', () => {
    expect(() => encodeAmount(-1n)).toThrow(AmountEncodingError);
  });

  it('refuses a non-canonical stored value', () => {
    expect(() => decodeAmount('007')).toThrow(AmountEncodingError);
    expect(() => decodeAmount('1.0')).toThrow(AmountEncodingError);
    expect(() => decodeAmount('')).toThrow(AmountEncodingError);
  });

  it('allows a negative only through the signed path', () => {
    expect(decodeSignedAmount(encodeSignedAmount(-500n))).toBe(-500n);
  });
});
