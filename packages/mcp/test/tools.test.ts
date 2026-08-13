import { describe, expect, it } from 'vitest';
import { createTools } from '../src/tools';

const WALLET = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const RECORD = { trader: WALLET, name: 'ace', display: 'ace', exists: true, seasons: [], proof: '' };
const STANDINGS = { season: { ordinal: 1, name: 'Season 1', finalizedAt: null }, standings: [], final: false };
const EMPTY_PROOF = { trader: WALLET, seasonId: 5, seasonOrdinal: 0, batches: [], note: 'nothing yet' };

function mockFetch(): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/proof')) return new Response(JSON.stringify(EMPTY_PROOF), { status: 200 });
    if (u.includes('/api/profile')) return new Response(JSON.stringify(RECORD), { status: 200 });
    if (u.includes('/api/leaderboard')) return new Response(JSON.stringify(STANDINGS), { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    if (body.method === 'getAccountInfo') return new Response(JSON.stringify({ result: { value: null } }), { status: 200 });
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('mcp tools', () => {
  const tools = createTools({ apiBase: 'http://probatio.test', rpc: 'http://rpc', fetchImpl: mockFetch() });

  it('get_record returns the public record', async () => {
    const record = await tools.getRecord({ wallet: WALLET });
    expect(record.trader).toBe(WALLET);
  });

  it('get_standings returns the season', async () => {
    const board = await tools.getStandings({});
    expect(board.season?.name).toBe('Season 1');
  });

  it('verify_record runs and reports not-verified for an empty record', async () => {
    const result = await tools.verifyRecord({ wallet: WALLET });
    expect(result.verified).toBe(false);
  });
});
