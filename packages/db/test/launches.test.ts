import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import {
  launchByMint,
  launchesByCreator,
  recentLaunches,
  recordLaunches,
  searchLaunches,
  type Launch,
} from '../src/launches';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const CREATOR = '9oNfewPW6KSxbKbTUCQ3g7tc2gViCEYijc6TbDaumwg1';
const NOW = 1_786_278_374_000;

let db: Client;

function launch(overrides: Partial<Launch> = {}): Omit<Launch, 'firstSeenAt'> {
  return {
    mint: MINT,
    bondingCurve: 'FHeBR39zwYtUuXQFLbShSsVKkEG6ti5Eup3zUdopiegi',
    creator: CREATOR,
    name: 'wrapped CATE',
    symbol: 'wCATE',
    uri: 'https://ipfs.io/ipfs/bafkreice4t5tto76n54rks4t7zqbzflkf3ztza36m7lalmksog',
    launchedAt: 1_786_271_082,
    slot: 438_197_000,
    ...overrides,
  };
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('recording launches', () => {
  it('stores and reads back', async () => {
    await recordLaunches(db, [launch()], NOW);
    const stored = (await launchByMint(db, MINT))!;
    expect(stored.symbol).toBe('wCATE');
    expect(stored.creator).toBe(CREATOR);
    expect(stored.firstSeenAt).toBe(NOW);
  });

  it('ignores a launch it has already seen', async () => {
    // A reconnecting stream replays recent history, and a launch seen twice is
    // not a second launch.
    await recordLaunches(db, [launch()], NOW);
    const inserted = await recordLaunches(db, [launch()], NOW + 60_000);
    expect(inserted).toBe(0);
  });

  it('keeps the original sighting rather than the latest', async () => {
    await recordLaunches(db, [launch()], NOW);
    await recordLaunches(db, [launch({ name: 'renamed' })], NOW + 60_000);

    const stored = (await launchByMint(db, MINT))!;
    expect(stored.firstSeenAt).toBe(NOW);
    expect(stored.name).toBe('wrapped CATE');
  });

  it('writes a batch at once', async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      launch({ mint: `mint${i}`, launchedAt: 1_786_271_000 + i }),
    );
    expect(await recordLaunches(db, many, NOW)).toBe(5);
  });

  it('does nothing for an empty batch', async () => {
    expect(await recordLaunches(db, [], NOW)).toBe(0);
  });

  it('rejects an implausible launch time', async () => {
    await expect(recordLaunches(db, [launch({ launchedAt: 1 })], NOW)).rejects.toThrow();
  });
});

describe('the feed', () => {
  it('returns newest first', async () => {
    await recordLaunches(
      db,
      [
        launch({ mint: 'old', launchedAt: 1_786_271_000 }),
        launch({ mint: 'new', launchedAt: 1_786_271_500 }),
        launch({ mint: 'middle', launchedAt: 1_786_271_200 }),
      ],
      NOW,
    );

    const feed = await recentLaunches(db);
    expect(feed.map((entry) => entry.mint)).toEqual(['new', 'middle', 'old']);
  });

  it('orders by the launch time, not when we noticed', async () => {
    // A stream that reconnects sees an older launch after a newer one. The
    // feed has to reflect the token's history, not our downtime.
    await recordLaunches(db, [launch({ mint: 'new', launchedAt: 1_786_271_500 })], NOW);
    await recordLaunches(db, [launch({ mint: 'old', launchedAt: 1_786_271_000 })], NOW + 60_000);

    expect((await recentLaunches(db)).map((entry) => entry.mint)).toEqual(['new', 'old']);
  });

  it('respects the limit', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      launch({ mint: `mint${i}`, launchedAt: 1_786_271_000 + i }),
    );
    await recordLaunches(db, many, NOW);
    expect(await recentLaunches(db, 3)).toHaveLength(3);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await recordLaunches(
      db,
      [
        launch({ mint: MINT, name: 'wrapped CATE', symbol: 'wCATE', launchedAt: 1_786_271_000 }),
        launch({ mint: 'm2', name: 'The Purple Toad', symbol: 'TOAD', launchedAt: 1_786_271_100 }),
        launch({ mint: 'm3', name: 'Cat Coin', symbol: 'CAT', launchedAt: 1_786_271_200 }),
        launch({ mint: 'm4', name: 'Toadstool', symbol: 'STOOL', launchedAt: 1_786_271_300 }),
      ],
      NOW,
    );
  });

  it('finds by symbol prefix', async () => {
    const results = await searchLaunches(db, 'TOA');
    expect(results.map((entry) => entry.symbol)).toContain('TOAD');
  });

  it('finds by name substring', async () => {
    const results = await searchLaunches(db, 'Toad');
    expect(results.map((entry) => entry.mint).sort()).toEqual(['m2', 'm4']);
  });

  it('puts an exact symbol match first', async () => {
    // Someone typing CAT means the token called CAT, not everything with those
    // letters in its name.
    const results = await searchLaunches(db, 'CAT');
    expect(results[0]!.symbol).toBe('CAT');
  });

  it('is case-insensitive on the exact match', async () => {
    expect((await searchLaunches(db, 'cat'))[0]!.symbol).toBe('CAT');
  });

  it('returns a pasted mint on its own', async () => {
    // Somebody pasting an address wants that token, not a list.
    const results = await searchLaunches(db, MINT);
    expect(results).toHaveLength(1);
    expect(results[0]!.mint).toBe(MINT);
  });

  it('returns nothing for an unknown mint rather than guessing', async () => {
    expect(await searchLaunches(db, 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump')).toEqual([]);
  });

  it('returns nothing for an empty query', async () => {
    expect(await searchLaunches(db, '')).toEqual([]);
    expect(await searchLaunches(db, '   ')).toEqual([]);
  });

  it('treats wildcards as literal characters', async () => {
    // Unescaped, '%' would match everything and turn a search box into a way
    // to dump the whole table.
    await recordLaunches(db, [launch({ mint: 'm5', name: '100% real', symbol: 'PCT' })], NOW);

    const results = await searchLaunches(db, '%');
    expect(results.map((entry) => entry.mint)).toEqual(['m5']);
  });

  it('treats an underscore as literal too', async () => {
    await recordLaunches(db, [launch({ mint: 'm6', name: 'snake_case', symbol: 'SNK' })], NOW);
    const results = await searchLaunches(db, '_c');
    expect(results.map((entry) => entry.mint)).toEqual(['m6']);
  });

  it('respects the limit', async () => {
    expect(await searchLaunches(db, 'o', 2)).toHaveLength(2);
  });
});

describe('by creator', () => {
  it('lists everything a wallet has launched, newest first', async () => {
    await recordLaunches(
      db,
      [
        launch({ mint: 'a', launchedAt: 1_786_271_000 }),
        launch({ mint: 'b', launchedAt: 1_786_271_500 }),
        launch({ mint: 'c', creator: 'someone-else', launchedAt: 1_786_271_600 }),
      ],
      NOW,
    );

    const theirs = await launchesByCreator(db, CREATOR);
    expect(theirs.map((entry) => entry.mint)).toEqual(['b', 'a']);
  });
});
