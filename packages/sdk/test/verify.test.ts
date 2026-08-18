import { describe, expect, it } from 'vitest';
import { buildTree, hashLeaf, toHex, type TradeLeaf } from '@probatio/commit';
import { Probatio, getStandings, verifyBundle, verifyRecord } from '../src/index';
import type { ProofBundle, SealedLeaf } from '../src/types';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

function leaf(sequence = 1): TradeLeaf {
  return {
    sequence,
    seasonOrdinal: 0,
    trader: TRADER,
    mint: MINT,
    side: 'buy',
    solAmount: 1_000_000n,
    tokenAmount: 30_000n,
    feeLamports: 12_500n,
    solReserve: 31_000_000_000n,
    tokenReserve: 1_000_000_000_000_000n,
    deliverableTokens: 700_000_000_000_000n,
    feeBps: 125,
    poolSource: 'pumpfun-curve',
    priceImpactBps: 10,
    partial: false,
    clickedAtSlot: 1_000,
    filledAtSlot: 1_002,
    latencyMs: 600,
    engineVersion: 1,
    createdAt: 1_700_000_000,
  };
}

/** A fill as the endpoint serves it: string amounts, plus the seal. */
function sealed(source: TradeLeaf, seal?: string): SealedLeaf {
  return {
    ...source,
    solAmount: source.solAmount.toString(),
    tokenAmount: source.tokenAmount.toString(),
    feeLamports: source.feeLamports.toString(),
    solReserve: source.solReserve.toString(),
    tokenReserve: source.tokenReserve.toString(),
    deliverableTokens: source.deliverableTokens.toString(),
    recordedHash: seal ?? toHex(hashLeaf(source)),
  };
}

function bundle(record: readonly SealedLeaf[]): ProofBundle {
  return { trader: TRADER, seasonId: 1, seasonOrdinal: 0, record, batches: [] };
}

function fetchReturning(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('verifyBundle', () => {
  it('verifies a record whose fills all rehash to their seals', () => {
    const result = verifyBundle(bundle([sealed(leaf())]));

    expect(result.verified).toBe(true);
    expect(result.tradeCount).toBe(1);
    expect(result.broken).toEqual([]);
    expect(result.root).toBe(toHex(buildTree([hashLeaf(leaf())]).root));
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('verifies a multi-fill record and roots it in order', () => {
    const fills = [leaf(1), leaf(2), leaf(3)];
    const result = verifyBundle(bundle(fills.map((one) => sealed(one))));

    expect(result.verified).toBe(true);
    expect(result.tradeCount).toBe(3);
    expect(result.root).toBe(toHex(buildTree(fills.map(hashLeaf)).root));
  });

  /*
   * The test the whole design exists for: a stored fill edited after the fact.
   * The seal is left as it was, which is what an edit in the database would
   * look like, and the figures no longer produce it.
   */
  it('catches a fill whose figures were changed after it was sealed', () => {
    const honest = leaf();
    const seal = toHex(hashLeaf(honest));
    const tampered = { ...honest, solAmount: 1n };

    const result = verifyBundle(bundle([sealed(tampered, seal)]));

    expect(result.verified).toBe(false);
    expect(result.broken).toEqual(['1']);
    expect(result.checks.some((check) => !check.passed && check.label === 'Seals')).toBe(true);
  });

  it('names only the fill that disagrees, not the whole record', () => {
    const good = leaf(1);
    const bad = leaf(2);
    const result = verifyBundle(
      bundle([sealed(good), sealed({ ...bad, feeLamports: 1n }, toHex(hashLeaf(bad)))]),
    );

    expect(result.verified).toBe(false);
    expect(result.broken).toEqual(['2']);
    expect(result.tradeCount).toBe(2);
  });

  it('reports a trader with no fills rather than passing them', () => {
    const result = verifyBundle(bundle([]));

    expect(result.verified).toBe(false);
    expect(result.tradeCount).toBe(0);
    expect(result.checks[0]?.passed).toBe(false);
  });

  /*
   * A record that has never been batched still verifies. This is the case that
   * used to fail everything: verification hung off commit history, and with
   * nothing committed every honest record was reported as unverifiable.
   */
  it('verifies a record with no batches at all', () => {
    const result = verifyBundle({
      trader: TRADER,
      seasonId: 1,
      seasonOrdinal: 0,
      record: [sealed(leaf())],
      batches: [],
    });

    expect(result.verified).toBe(true);
  });
});

describe('verifyRecord', () => {
  it('fetches a record and verifies it without any endpoint being configured', async () => {
    const result = await verifyRecord(TRADER, {
      apiBase: 'https://example.test',
      fetchImpl: fetchReturning(bundle([sealed(leaf())])),
    });

    expect(result.verified).toBe(true);
    expect(result.trader).toBe(TRADER);
  });
});

describe('Probatio client', () => {
  it('verifies with nothing but an api base', async () => {
    const client = new Probatio({
      apiBase: 'https://example.test',
      fetchImpl: fetchReturning(bundle([sealed(leaf())])),
    });

    await expect(client.verifyRecord(TRADER)).resolves.toMatchObject({ verified: true });
  });

  it('reads standings', async () => {
    const rows = [{ pubkey: TRADER, returnBps: 120, trips: 4 }];
    const client = new Probatio({
      apiBase: 'https://example.test',
      fetchImpl: fetchReturning({ leaderboard: rows }),
    });

    // The endpoint's envelope, not a bare array: `Standings` is the whole body.
    await expect(client.getStandings()).resolves.toEqual({ leaderboard: rows });
  });

  it('standalone getStandings hits the leaderboard', async () => {
    const rows = [{ pubkey: TRADER, returnBps: 5, trips: 1 }];
    await expect(
      getStandings({ apiBase: 'https://example.test', fetchImpl: fetchReturning({ leaderboard: rows }) }),
    ).resolves.toEqual({ leaderboard: rows });
  });
});
