import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { pruneCandles, prunePoolSnapshots, runRetention } from '../src/retention';

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
  it('drops one-second candles older than an hour but keeps recent ones', async () => {
    // `now` in seconds, matched to how the candles are written.
    const now = 1_000 * DAY;
    await writeCandle('s1', now - 30); // half a minute ago: kept
    await writeCandle('s1', now - 2 * HOUR); // two hours ago: dropped

    await pruneCandles(test.db, now * 1_000);

    expect(await candleCount('s1')).toBe(1);
  });

  it('keeps hourly candles that a one-second window would have dropped', async () => {
    const now = 1_000 * DAY;
    await writeCandle('h1', now - 30 * DAY); // a month of hourly history is still a chart
    await writeCandle('s1', now - 30 * DAY); // the same age at one second is long gone

    await pruneCandles(test.db, now * 1_000);

    expect(await candleCount('h1')).toBe(1);
    expect(await candleCount('s1')).toBe(0);
  });

  it('reports how many rows it dropped', async () => {
    const now = 1_000 * DAY;
    await writeCandle('s1', now - 2 * HOUR);
    await writeCandle('s1', now - 3 * HOUR);
    await writeCandle('s1', now - 10); // kept

    const result = await runRetention(test.db, now * 1_000);
    expect(result.candlesDeleted).toBe(2);
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
    const now = 1_000 * DAY;
    await writeSnapshot(1, now - 30 * DAY); // old, not newest: dropped
    await writeSnapshot(2, now - 20 * DAY); // old, but newest for the mint: kept

    const dropped = await prunePoolSnapshots(test.db, now * 1_000);

    expect(dropped).toBe(1);
    const left = await test.db.execute('SELECT slot FROM pool_snapshots');
    expect(left.rows.map((r) => Number(r['slot']))).toEqual([2]);
  });
});
