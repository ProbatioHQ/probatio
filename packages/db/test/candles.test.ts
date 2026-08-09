import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import { getBackfill, readCandles, recordBackfill, writeCandles, type CandleWrite } from '../src/candles';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const TF = 'm1';

let db: Client;

function candle(openTime: number, overrides: Partial<CandleWrite> = {}): CandleWrite {
  return {
    openTime,
    open: 100n,
    high: 150n,
    low: 80n,
    close: 120n,
    volumeLamports: 1_000n,
    trades: 3,
    ...overrides,
  };
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('writeCandles', () => {
  it('stores and reads back oldest first', async () => {
    await writeCandles(db, MINT, TF, [candle(120), candle(60), candle(180)]);
    const stored = await readCandles(db, MINT, TF);
    expect(stored.map((c) => c.openTime)).toEqual([60, 120, 180]);
  });

  it('does nothing for an empty list', async () => {
    await writeCandles(db, MINT, TF, []);
    expect(await readCandles(db, MINT, TF)).toEqual([]);
  });

  it('keeps prices exact as strings', async () => {
    // A price scaled by 1e18 exceeds what a REAL column could hold without
    // rounding, which is the entire reason these are strings.
    const huge = 30_959_691_067_748n;
    await writeCandles(db, MINT, TF, [candle(60, { open: huge, close: huge, high: huge, low: huge })]);
    expect((await readCandles(db, MINT, TF))[0]!.open).toBe(huge.toString());
  });
});

describe('merging into an open bucket', () => {
  it('keeps the original open and takes the new close', async () => {
    await writeCandles(db, MINT, TF, [candle(60, { open: 100n, close: 120n })]);
    await writeCandles(db, MINT, TF, [candle(60, { open: 120n, close: 200n })]);

    const [stored] = await readCandles(db, MINT, TF);
    expect(stored!.open).toBe('100');
    expect(stored!.close).toBe('200');
  });

  it('widens the high and low', async () => {
    await writeCandles(db, MINT, TF, [candle(60, { high: 150n, low: 80n })]);
    await writeCandles(db, MINT, TF, [candle(60, { high: 300n, low: 10n })]);

    const [stored] = await readCandles(db, MINT, TF);
    expect(stored!.high).toBe('300');
    expect(stored!.low).toBe('10');
  });

  it('does not narrow the high or low', async () => {
    await writeCandles(db, MINT, TF, [candle(60, { high: 300n, low: 10n })]);
    await writeCandles(db, MINT, TF, [candle(60, { high: 150n, low: 80n })]);

    const [stored] = await readCandles(db, MINT, TF);
    expect(stored!.high).toBe('300');
    expect(stored!.low).toBe('10');
  });

  it('compares numerically, not as text', async () => {
    // '9' sorts above '10' lexicographically. A text comparison here would pick
    // the wrong extreme on any bucket spanning a digit-count boundary.
    await writeCandles(db, MINT, TF, [candle(60, { high: 9n, low: 9n })]);
    await writeCandles(db, MINT, TF, [candle(60, { high: 10n, low: 8n })]);

    const [stored] = await readCandles(db, MINT, TF);
    expect(stored!.high).toBe('10');
    expect(stored!.low).toBe('8');
  });

  it('accumulates volume and trade count', async () => {
    await writeCandles(db, MINT, TF, [candle(60, { volumeLamports: 1_000n, trades: 3 })]);
    await writeCandles(db, MINT, TF, [candle(60, { volumeLamports: 500n, trades: 2 })]);

    const [stored] = await readCandles(db, MINT, TF);
    expect(stored!.volume).toBe('1500');
    expect(stored!.trades).toBe(5);
  });

  it('keeps timeframes separate', async () => {
    await writeCandles(db, MINT, 'm1', [candle(60)]);
    await writeCandles(db, MINT, 's5', [candle(60)]);
    expect(await readCandles(db, MINT, 'm1')).toHaveLength(1);
    expect(await readCandles(db, MINT, 's5')).toHaveLength(1);
  });

  it('keeps mints separate', async () => {
    await writeCandles(db, MINT, TF, [candle(60)]);
    await writeCandles(db, 'other', TF, [candle(60)]);
    expect(await readCandles(db, MINT, TF)).toHaveLength(1);
  });
});

describe('readCandles', () => {
  it('returns the most recent window when there are more than the limit', async () => {
    await writeCandles(
      db,
      MINT,
      TF,
      Array.from({ length: 10 }, (_, i) => candle(i * 60)),
    );

    const stored = await readCandles(db, MINT, TF, 3);
    expect(stored.map((c) => c.openTime)).toEqual([420, 480, 540]);
  });
});

describe('backfill records', () => {
  it('records how far history was reconstructed', async () => {
    await recordBackfill(
      db,
      { mint: MINT, oldestTimestamp: 100, newestTimestamp: 500, observations: 42, truncated: false },
      1_000,
    );

    const record = (await getBackfill(db, MINT))!;
    expect(record.oldestTimestamp).toBe(100);
    expect(record.newestTimestamp).toBe(500);
    expect(record.observations).toBe(42);
    expect(record.truncated).toBe(false);
  });

  it('widens the window on a later pass rather than replacing it', async () => {
    await recordBackfill(
      db,
      { mint: MINT, oldestTimestamp: 300, newestTimestamp: 500, observations: 10, truncated: true },
      1_000,
    );
    await recordBackfill(
      db,
      { mint: MINT, oldestTimestamp: 100, newestTimestamp: 900, observations: 5, truncated: false },
      2_000,
    );

    const record = (await getBackfill(db, MINT))!;
    expect(record.oldestTimestamp).toBe(100);
    expect(record.newestTimestamp).toBe(900);
    expect(record.observations).toBe(15);
    expect(record.truncated).toBe(false);
  });

  it('returns null for a token never backfilled', async () => {
    expect(await getBackfill(db, 'unknown')).toBeNull();
  });

  it('distinguishes truncated history from complete history', async () => {
    // Without this a chart would claim a token launched at the oldest candle
    // it happens to hold, when really that is just where the budget ran out.
    await recordBackfill(
      db,
      { mint: MINT, oldestTimestamp: 100, newestTimestamp: 500, observations: 500, truncated: true },
      1_000,
    );
    expect((await getBackfill(db, MINT))!.truncated).toBe(true);
  });
});
