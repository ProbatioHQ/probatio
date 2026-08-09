import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';

const PUBKEY = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';

let db: Client;
let accountId: number;

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);

  const now = Date.now();
  await db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?)',
    args: [PUBKEY, now],
  });
  const season = await db.execute({
    sql: `INSERT INTO seasons (
            ordinal, name, ranked, status, starting_balance, entry_cost,
            min_trades, min_distinct_tokens, house_bps, house_threshold,
            latency_ms, max_price_impact_bps, engine_version,
            scoring_formula_hash, created_at
          ) VALUES (1, 'S1', 1, 'pending', '10000000000', '50000000',
                    30, 20, 1000, '1000000000', 500, 5000, 1, 'h', ?)
          RETURNING id`,
    args: [now],
  });
  const account = await db.execute({
    sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
          VALUES (?, ?, '0', ?, ?) RETURNING id`,
    args: [Number(season.rows[0]!['id']), PUBKEY, now, now],
  });
  accountId = Number(account.rows[0]!['id']);
});

async function setBalance(value: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE accounts SET sol_balance = ? WHERE id = ?',
    args: [value, accountId],
  });
}

describe('unsigned amount constraint', () => {
  it.each(['0', '1', '10000000000', '18446744073709551616'])('accepts %s', async (value) => {
    await expect(setBalance(value)).resolves.toBeUndefined();
  });

  it.each([
    ['a float', '1.5'],
    ['a negative', '-1'],
    ['scientific notation', '1e9'],
    ['an empty string', ''],
    ['whitespace', ' 1'],
    ['a trailing space', '1 '],
    ['a leading zero', '007'],
    ['letters', 'abc'],
    ['a comma', '1,000'],
    ['a plus sign', '+1'],
  ])('rejects %s', async (_label, value) => {
    await expect(setBalance(value)).rejects.toThrow();
  });
});

describe('signed amount constraint', () => {
  async function setPnl(value: string): Promise<void> {
    await db.execute({
      sql: `INSERT INTO positions
              (account_id, mint, token_amount, cost_basis, realized_pnl, opened_at, updated_at)
            VALUES (?, 'mint', '0', '0', ?, ?, ?)`,
      args: [accountId, value, Date.now(), Date.now()],
    });
  }

  it.each(['0', '500', '-500', '-18446744073709551616'])('accepts %s', async (value) => {
    await expect(setPnl(value)).resolves.toBeUndefined();
  });

  it.each([
    ['a float', '-1.5'],
    ['a bare minus', '-'],
    ['negative zero', '-0'],
    ['a leading zero', '-007'],
    ['letters', '-abc'],
  ])('rejects %s', async (_label, value) => {
    await expect(setPnl(value)).rejects.toThrow();
  });
});
