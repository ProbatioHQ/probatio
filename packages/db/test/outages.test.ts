import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outageMinutes } from '@probatio/health';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { closeOutage, openOutage, openOutages, outagesBetween } from '../src/index';

const T = 1_700_000_000_000;
const MIN = 60_000;

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
});

afterEach(() => harness.cleanup());

describe('recording an outage', () => {
  it('opens and closes one', async () => {
    await openOutage(harness.db, 'rpc', T, 'timeout');
    expect(await openOutages(harness.db)).toHaveLength(1);

    expect(await closeOutage(harness.db, 'rpc', T + 10 * MIN)).toBe(true);
    expect(await openOutages(harness.db)).toHaveLength(0);
  });

  it('does not open a second one while the first is running', async () => {
    // The expected path on every probe after the first.
    await openOutage(harness.db, 'rpc', T, 'timeout');
    await openOutage(harness.db, 'rpc', T + MIN, 'timeout again');
    await openOutage(harness.db, 'rpc', T + 2 * MIN, 'still down');

    const open = await openOutages(harness.db);
    expect(open).toHaveLength(1);
    // An outage began when it began, not when the next probe confirmed it.
    expect(open[0]!.startedAt).toBe(T);
  });

  it('keeps dependencies apart', async () => {
    await openOutage(harness.db, 'rpc', T, null);
    await openOutage(harness.db, 'feed', T, null);
    expect(await openOutages(harness.db)).toHaveLength(2);

    await closeOutage(harness.db, 'rpc', T + MIN);
    expect((await openOutages(harness.db)).map((o) => o.dependency)).toEqual(['feed']);
  });

  it('reports nothing closed when nothing was open', async () => {
    expect(await closeOutage(harness.db, 'rpc', T)).toBe(false);
  });

  it('can open a new outage after the last one closed', async () => {
    await openOutage(harness.db, 'rpc', T, null);
    await closeOutage(harness.db, 'rpc', T + MIN);
    await openOutage(harness.db, 'rpc', T + 5 * MIN, null);

    expect(await openOutages(harness.db)).toHaveLength(1);
  });
});

describe('reading a window', () => {
  it('finds an outage inside it', async () => {
    await openOutage(harness.db, 'rpc', T + 5 * MIN, null);
    await closeOutage(harness.db, 'rpc', T + 10 * MIN);

    expect(await outagesBetween(harness.db, T, T + 60 * MIN)).toHaveLength(1);
  });

  it('finds one that straddles the start', async () => {
    await openOutage(harness.db, 'rpc', T - 10 * MIN, null);
    await closeOutage(harness.db, 'rpc', T + 5 * MIN);

    expect(await outagesBetween(harness.db, T, T + 60 * MIN)).toHaveLength(1);
  });

  it('finds one still open', async () => {
    await openOutage(harness.db, 'rpc', T + 5 * MIN, null);
    expect(await outagesBetween(harness.db, T, T + 60 * MIN)).toHaveLength(1);
  });

  it('ignores one entirely before the window', async () => {
    await openOutage(harness.db, 'rpc', T - 60 * MIN, null);
    await closeOutage(harness.db, 'rpc', T - 30 * MIN);

    expect(await outagesBetween(harness.db, T, T + 60 * MIN)).toHaveLength(0);
  });
});

describe('feeding the void assessment', () => {
  it('answers how many minutes a season lost', async () => {
    // The whole reason this table exists. A season is void over two hours of
    // feed outage, and a threshold nobody measures is not a rule.
    await openOutage(harness.db, 'feed', T + 10 * MIN, null);
    await closeOutage(harness.db, 'feed', T + 100 * MIN);
    await openOutage(harness.db, 'feed', T + 200 * MIN, null);
    await closeOutage(harness.db, 'feed', T + 245 * MIN);

    const rows = await outagesBetween(harness.db, T, T + 300 * MIN);
    const minutes = outageMinutes(
      rows.map((row) => ({
        dependency: row.dependency,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        detail: row.detail,
      })),
      T,
      T + 300 * MIN,
      T + 300 * MIN,
    );

    expect(minutes).toBe(135);
  });
});
