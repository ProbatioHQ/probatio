import { describe, expect, it } from 'vitest';
import {
  EMPTY_ACCUMULATOR,
  buildTree,
  extendChain,
  fromHex,
  hashLeaf,
  toHex,
  type TradeLeaf,
} from '@probatio/commit';
import { PROGRAM_ID, TRADER_RECORD_DISCRIMINATOR } from '../src/constants';
import { Probatio, ProbatioError, getStandings, verifyRecord } from '../src/index';
import type { ProofBundle, RawLeaf } from '../src/types';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

function leaf(): TradeLeaf {
  return {
    sequence: 1,
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

function raw(source: TradeLeaf): RawLeaf {
  return {
    ...source,
    solAmount: source.solAmount.toString(),
    tokenAmount: source.tokenAmount.toString(),
    feeLamports: source.feeLamports.toString(),
    solReserve: source.solReserve.toString(),
    tokenReserve: source.tokenReserve.toString(),
    deliverableTokens: source.deliverableTokens.toString(),
  };
}

const L = leaf();
const ROOT = toHex(buildTree([hashLeaf(L)]).root);
const ACCUMULATOR = toHex(extendChain(EMPTY_ACCUMULATOR, fromHex(ROOT), 1, 1));

function bundle(trades: readonly RawLeaf[] = [raw(L)]): ProofBundle {
  return {
    trader: TRADER,
    seasonId: 5,
    seasonOrdinal: 0,
    batches: [
      {
        batchIndex: 0,
        root: ROOT,
        leaves: 1,
        engineVersion: 1,
        previousAccumulator: toHex(EMPTY_ACCUMULATOR),
        predictedAccumulator: ACCUMULATOR,
        txSignature: 'sig',
        slot: 100,
        trades,
      },
    ],
  };
}

/** A 104-byte TraderRecord account holding `accumulatorHex`, base64. */
function recordAccount(accumulatorHex: string): string {
  const data = new Uint8Array(104);
  data.set(fromHex(TRADER_RECORD_DISCRIMINATOR), 0);
  data.set(fromHex(accumulatorHex), 72);
  return Buffer.from(data).toString('base64');
}

const STANDINGS = {
  season: { ordinal: 1, name: 'Season 1', status: 'running', entrants: 1, potLamports: '0', scoring: 'highest_return' },
  standings: [
    { rank: 1, trader: TRADER, name: null, returnBps: 5000, finalEquity: '15', startingBalance: '10', tradeCount: 4, payoutLamports: '0' },
  ],
  total: 1,
  final: false,
};

/** A fetch that serves a proof bundle, a leaderboard, and an RPC account. */
function mockFetch(proof: ProofBundle | null, onChainAccumulator: string | null): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/proof')) return new Response(JSON.stringify(proof ?? {}), { status: 200 });
    if (u.includes('/api/leaderboard')) return new Response(JSON.stringify(STANDINGS), { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    if (body.method === 'getAccountInfo') {
      const value =
        onChainAccumulator === null
          ? null
          : { data: [recordAccount(onChainAccumulator), 'base64'], owner: PROGRAM_ID };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as unknown as typeof fetch;
}

const opts = (fetchImpl: typeof fetch) => ({ rpc: 'http://rpc.test', apiBase: 'http://probatio.test', fetchImpl });

describe('verifyRecord', () => {
  it('verifies a record whose trades fold to the accumulator the chain holds', async () => {
    const result = await verifyRecord(TRADER, opts(mockFetch(bundle(), ACCUMULATOR)));
    expect(result.verified).toBe(true);
    expect(result.onChainAccumulator).toBe(ACCUMULATOR);
    expect(result.computedAccumulator).toBe(ACCUMULATOR);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.tradeCount).toBe(1);
  });

  it('rejects a record the chain does not hold', async () => {
    // The chain holds a different accumulator than the trades produce.
    const other = toHex(extendChain(EMPTY_ACCUMULATOR, fromHex(ROOT), 1, 2));
    const result = await verifyRecord(TRADER, opts(mockFetch(bundle(), other)));
    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.label === 'On-chain comparison')?.passed).toBe(false);
  });

  it('rejects a tampered trade whose root no longer rebuilds', async () => {
    const tampered = { ...raw(L), solAmount: '999' };
    const result = await verifyRecord(TRADER, opts(mockFetch(bundle([tampered]), ACCUMULATOR)));
    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.label === 'Roots rebuilt from trades')?.passed).toBe(false);
  });

  it('reports a trader with nothing committed', async () => {
    const empty: ProofBundle = { trader: TRADER, seasonId: 5, seasonOrdinal: 0, batches: [], note: 'nothing yet' };
    const result = await verifyRecord(TRADER, opts(mockFetch(empty, ACCUMULATOR)));
    expect(result.verified).toBe(false);
    expect(result.checks[0]!.label).toBe('Committed record');
    expect(result.tradeCount).toBe(0);
  });
});

describe('Probatio client', () => {
  it('reads standings', async () => {
    const client = new Probatio({ apiBase: 'http://probatio.test', fetchImpl: mockFetch(null, null) });
    const standings = await client.getStandings();
    expect(standings.standings[0]!.trader).toBe(TRADER);
  });

  it('refuses to verify without an rpc endpoint', () => {
    const client = new Probatio({ apiBase: 'http://probatio.test', fetchImpl: mockFetch(bundle(), ACCUMULATOR) });
    expect(() => client.verifyRecord(TRADER)).toThrow(ProbatioError);
  });

  it('standalone getStandings hits the leaderboard', async () => {
    const standings = await getStandings({ apiBase: 'http://probatio.test', fetchImpl: mockFetch(null, null) });
    expect(standings.final).toBe(false);
  });

  it('getStandings sends limit but never a season the endpoint would ignore', async () => {
    let seen = '';
    const fetchImpl = (async (url: string | URL) => {
      seen = String(url);
      return new Response(JSON.stringify(STANDINGS), { status: 200 });
    }) as unknown as typeof fetch;
    await getStandings({ apiBase: 'http://probatio.test', fetchImpl, limit: 25 });
    expect(seen).toContain('limit=25');
    expect(seen).not.toContain('season');
  });
});
