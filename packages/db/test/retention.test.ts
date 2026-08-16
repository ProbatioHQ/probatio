import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  CANDLE_KEEP,
  pruneCandles,
  pruneLaunches,
  prunePoolSnapshots,
  runRetention,
} from '../src/retention';

const MINT = 'So11111111111111111111111111111111111111112';
const HOUR = 3_600;
const DAY = 24 * HOUR;

let test: TestDatabase;

beforeEach(async () => {
  test = await createTestDatabase();
});
afterEach(() => test.cleanup());

async function writeCandle(timeframe: string, openTime: number): Promise<void> {
  await test.db.execute({
    sql: `INSERT INTO candles (mint, timeframe, open_time, open, high, low, close, volume, trades)
          VALUES (?, ?, ?, '1', '1', '1', '1', '0', 0)`,
    args: [MINT, timeframe, openTime],
  });
}

async function candleCount(timeframe: string): Promise<number> {
  const result = await test.db.execute({
    sql: 'SELECT COUNT(*) AS n FROM candles WHERE timeframe = ?',
    args: [timeframe],
  });
  return Number(result.rows[0]!['n']);
}

describe('candle retention', () => {
  it('keeps the most recent CANDLE_KEEP of a timeframe and drops the rest', async () => {
    const now = 1_000 * DAY;
    // A few more than the cap; the oldest few should be dropped.
    const over = 3;
    for (let i = 0; i < CANDLE_KEEP + over; i += 1) {
      await writeCandle('s1', now - i);
    }

    const dropped = await pruneCandles(test.db);

    expect(dropped).toBe(over);
    expect(await candleCount('s1')).toBe(CANDLE_KEEP);
  });

  it('keeps a sparse old timeframe in full, however far back it reaches', async () => {
    const now = 1_000 * DAY;
    // Far fewer than the cap, but months old: a full chart, all kept.
    await writeCandle('d1', now - 100 * DAY);
    await writeCandle('d1', now - 50 * DAY);
    await writeCandle('d1', now - 1 * DAY);

    await pruneCandles(test.db);

    expect(await candleCount('d1')).toBe(3);
  });

  it('counts each timeframe on its own, not pooled together', async () => {
    const now = 1_000 * DAY;
    // The cap is per timeframe, so filling one does not evict another's.
    for (let i = 0; i < CANDLE_KEEP + 5; i += 1) await writeCandle('s1', now - i);
    await writeCandle('h1', now - 10 * DAY);

    await pruneCandles(test.db);

    expect(await candleCount('s1')).toBe(CANDLE_KEEP);
    expect(await candleCount('h1')).toBe(1);
  });

  it('reports how many rows it dropped', async () => {
    const now = 1_000 * DAY;
    for (let i = 0; i < CANDLE_KEEP + 2; i += 1) await writeCandle('s1', now - i);

    const result = await runRetention(test.db, now * 1_000);
    expect(result.candlesDeleted).toBe(2);
  });
});

describe('launch retention', () => {
  async function writeLaunch(mint: string, launchedAt: number): Promise<void> {
    await test.db.execute({
      sql: `INSERT INTO launches
              (mint, bonding_curve, creator, name, symbol, uri, launched_at, first_seen_at)
            VALUES (?, 'curve', 'creator', 'Name', 'SYM', 'uri', ?, ?)`,
      args: [mint, launchedAt, launchedAt],
    });
  }

  // A real unix-seconds clock: launches carry a CHECK that they are after 2020.
  const NOW = 1_800_000_000;

  it('drops old launches but keeps recent ones', async () => {
    await writeLaunch('old', NOW - 30 * DAY);
    await writeLaunch('new', NOW - 1 * DAY);

    const dropped = await pruneLaunches(test.db, NOW * 1_000);

    expect(dropped).toBe(1);
    const left = await test.db.execute('SELECT mint FROM launches');
    expect(left.rows.map((r) => String(r['mint']))).toEqual(['new']);
  });

  it('keeps an old launch while a player still holds the token', async () => {
    await writeLaunch('held', NOW - 30 * DAY);

    // The minimum a held position needs to exist: a user, a season, an account.
    const user = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    await test.db.execute({ sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, 1)', args: [user] });
    const season = await test.db.execute({
      sql: `INSERT INTO seasons (ordinal, name, ranked, status, starting_balance, entry_cost,
              house_bps, house_threshold, latency_ms, max_price_impact_bps, engine_version,
              scoring_formula_hash, created_at)
            VALUES (1, 'S', 0, 'running', '10', '0', 0, '0', 0, 0, 1, ?, 1) RETURNING id`,
      args: ['a'.repeat(64)],
    });
    const seasonId = Number(season.rows[0]!['id']);
    const account = await test.db.execute({
      sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
            VALUES (?, ?, '10', 1, 1) RETURNING id`,
      args: [seasonId, user],
    });
    const accountId = Number(account.rows[0]!['id']);
    await test.db.execute({
      sql: `INSERT INTO positions (account_id, mint, token_amount, cost_basis, realized_pnl, opened_at, updated_at)
            VALUES (?, 'held', '5', '5', '0', 1, 1)`,
      args: [accountId],
    });

    const dropped = await pruneLaunches(test.db, NOW * 1_000);

    expect(dropped).toBe(0);
    const left = await test.db.execute('SELECT mint FROM launches');
    expect(left.rows.map((r) => String(r['mint']))).toEqual(['held']);
  });
});

describe('pool snapshot retention', () => {
  async function writeSnapshot(slot: number, observedAt: number): Promise<void> {
    await test.db.execute({
      sql: `INSERT INTO pool_snapshots
              (mint, sol_reserve, token_reserve, token_decimals, fee_bps, source, slot, observed_at)
            VALUES (?, '1', '1', 6, 25, 'pumpfun-curve', ?, ?)`,
      args: [MINT, slot, observedAt],
    });
  }

  it('drops old snapshots but keeps the newest for each mint', async () => {
    // observed_at is written in milliseconds in production (Date.now()), so the
    // test writes and prunes in milliseconds — the units have to match or the
    // prune is a no-op the way it was before this was caught.
    const nowMs = 1_800_000_000_000;
    const dayMs = DAY * 1_000;
    await writeSnapshot(1, nowMs - 30 * dayMs); // old, not newest: dropped
    await writeSnapshot(2, nowMs - 20 * dayMs); // old, but newest for the mint: kept

    const dropped = await prunePoolSnapshots(test.db, nowMs);

    expect(dropped).toBe(1);
    const left = await test.db.execute('SELECT slot FROM pool_snapshots');
    expect(left.rows.map((r) => Number(r['slot']))).toEqual([2]);
  });
});
