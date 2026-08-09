import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import {
  displayName,
  displaySymbol,
  getManyTokenMetadata,
  getTokenMetadata,
  recordOffchainFailure,
  recordOffchainMetadata,
  staleOffchainMints,
  upsertOnchainMetadata,
} from '../src/metadata';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const OTHER = 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump';
const NOW = 1_700_000_000_000;

let db: Client;

async function seedOnchain(mint = MINT, uri: string | null = 'https://ipfs.io/ipfs/abc') {
  await upsertOnchainMetadata(
    db,
    {
      mint,
      name: 'wrapped CATE',
      symbol: 'wCATE',
      uri,
      updateAuthority: 'authority',
      decimals: 6,
    },
    NOW,
  );
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('on-chain half', () => {
  it('stores and reads back', async () => {
    await seedOnchain();
    const entry = (await getTokenMetadata(db, MINT))!;
    expect(entry.name).toBe('wrapped CATE');
    expect(entry.symbol).toBe('wCATE');
    expect(entry.decimals).toBe(6);
    expect(entry.onchainFetchedAt).toBe(NOW);
    expect(entry.offchainFetchedAt).toBeNull();
  });

  it('updates on a second read without duplicating', async () => {
    await seedOnchain();
    await upsertOnchainMetadata(
      db,
      { mint: MINT, name: 'renamed', symbol: 'NEW', uri: null, updateAuthority: null, decimals: 6 },
      NOW + 1000,
    );

    const entry = (await getTokenMetadata(db, MINT))!;
    expect(entry.name).toBe('renamed');
    expect(entry.onchainFetchedAt).toBe(NOW + 1000);

    const count = await db.execute('SELECT COUNT(*) AS n FROM token_metadata');
    expect(Number(count.rows[0]!['n'])).toBe(1);
  });

  it('does not clear the off-chain half when the chain half is refreshed', async () => {
    await seedOnchain();
    await recordOffchainMetadata(
      db,
      MINT,
      { name: 'off', symbol: 'OFF', description: 'd', imageUrl: 'https://x/i.png' },
      NOW,
    );

    // Metadata is mutable. A name change on chain should not throw away a
    // perfectly good cached image.
    await upsertOnchainMetadata(
      db,
      { mint: MINT, name: 'renamed', symbol: 'NEW', uri: null, updateAuthority: null, decimals: 6 },
      NOW + 1000,
    );

    const entry = (await getTokenMetadata(db, MINT))!;
    expect(entry.imageUrl).toBe('https://x/i.png');
    expect(entry.description).toBe('d');
  });

  it('rejects implausible decimals', async () => {
    await expect(
      upsertOnchainMetadata(
        db,
        { mint: MINT, name: null, symbol: null, uri: null, updateAuthority: null, decimals: 40 },
        NOW,
      ),
    ).rejects.toThrow();
  });
});

describe('off-chain half', () => {
  it('records a success and clears any previous error', async () => {
    await seedOnchain();
    await recordOffchainFailure(db, MINT, 'gateway down', NOW);
    await recordOffchainMetadata(
      db,
      MINT,
      { name: 'n', symbol: 's', description: 'd', imageUrl: 'https://x/i.png' },
      NOW + 500,
    );

    const entry = (await getTokenMetadata(db, MINT))!;
    expect(entry.offchainError).toBeNull();
    expect(entry.offchainFetchedAt).toBe(NOW + 500);
  });

  it('stamps a timestamp on failure too', async () => {
    await seedOnchain();
    await recordOffchainFailure(db, MINT, 'gateway down', NOW);

    // Without this, a token with a dead gateway is retried on every page load.
    const entry = (await getTokenMetadata(db, MINT))!;
    expect(entry.offchainFetchedAt).toBe(NOW);
    expect(entry.offchainError).toBe('gateway down');
  });

  it('truncates a very long error', async () => {
    await seedOnchain();
    await recordOffchainFailure(db, MINT, 'x'.repeat(5_000), NOW);
    expect((await getTokenMetadata(db, MINT))!.offchainError!.length).toBe(500);
  });
});

describe('staleOffchainMints', () => {
  it('returns never-fetched mints first', async () => {
    await seedOnchain(MINT);
    await seedOnchain(OTHER);
    await recordOffchainMetadata(
      db,
      OTHER,
      { name: null, symbol: null, description: null, imageUrl: null },
      NOW - 1_000_000,
    );

    const stale = await staleOffchainMints(db, NOW, 10);
    expect(stale[0]).toBe(MINT);
    expect(stale).toContain(OTHER);
  });

  it('skips anything fetched recently', async () => {
    await seedOnchain(MINT);
    await recordOffchainMetadata(
      db,
      MINT,
      { name: null, symbol: null, description: null, imageUrl: null },
      NOW,
    );
    expect(await staleOffchainMints(db, NOW - 1, 10)).toEqual([]);
  });

  it('skips tokens with no uri to fetch', async () => {
    await seedOnchain(MINT, null);
    expect(await staleOffchainMints(db, NOW, 10)).toEqual([]);
  });

  it('respects the limit', async () => {
    await seedOnchain(MINT);
    await seedOnchain(OTHER);
    expect(await staleOffchainMints(db, NOW, 1)).toHaveLength(1);
  });
});

describe('getManyTokenMetadata', () => {
  it('reads a batch in one query', async () => {
    await seedOnchain(MINT);
    await seedOnchain(OTHER);
    const found = await getManyTokenMetadata(db, [MINT, OTHER, 'unknown']);
    expect(found.size).toBe(2);
    expect(found.get(MINT)!.symbol).toBe('wCATE');
  });

  it('handles an empty list without querying', async () => {
    expect((await getManyTokenMetadata(db, [])).size).toBe(0);
  });
});

describe('display fallbacks', () => {
  it('prefers the on-chain name', async () => {
    await seedOnchain();
    await recordOffchainMetadata(
      db,
      MINT,
      { name: 'off-chain name', symbol: 'OFF', description: null, imageUrl: null },
      NOW,
    );

    // On-chain wins: changing it costs a transaction and the update authority,
    // whereas the off-chain document can be swapped silently at any moment.
    const entry = (await getTokenMetadata(db, MINT))!;
    expect(displayName(entry)).toBe('wrapped CATE');
    expect(displaySymbol(entry)).toBe('wCATE');
  });

  it('falls back to off-chain, then to the mint', async () => {
    await upsertOnchainMetadata(
      db,
      { mint: MINT, name: null, symbol: null, uri: null, updateAuthority: null, decimals: 6 },
      NOW,
    );
    let entry = (await getTokenMetadata(db, MINT))!;
    expect(displayName(entry)).toBe(MINT.slice(0, 4));
    expect(displaySymbol(entry)).toBe('???');

    await recordOffchainMetadata(
      db,
      MINT,
      { name: 'off-chain name', symbol: 'OFF', description: null, imageUrl: null },
      NOW,
    );
    entry = (await getTokenMetadata(db, MINT))!;
    expect(displayName(entry)).toBe('off-chain name');
    expect(displaySymbol(entry)).toBe('OFF');
  });
});
