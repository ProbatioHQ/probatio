import { describe, expect, it } from 'vitest';
import { run, type CliIo } from '../src/cli';

const WALLET = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';

const RECORD = {
  trader: WALLET,
  name: 'ace',
  display: 'ace',
  exists: true,
  seasons: [{ ordinal: 1, name: 'Season 1', ranked: true, returnBps: 4200, tradeCount: 9, committed: true }],
  proof: `/api/proof?trader=${WALLET}`,
};

const STANDINGS = {
  season: { ordinal: 1, name: 'Season 1', finalizedAt: null },
  standings: [{ rank: 1, trader: WALLET, name: 'ace', returnBps: 4200, finalEquity: '14', startingBalance: '10', tradeCount: 9, payoutLamports: '0' }],
  final: false,
};

const EMPTY_PROOF = { trader: WALLET, seasonId: 5, seasonOrdinal: 0, batches: [], note: 'nothing yet' };

function mockFetch(): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/proof')) return new Response(JSON.stringify(EMPTY_PROOF), { status: 200 });
    if (u.includes('/api/profile')) return new Response(JSON.stringify(RECORD), { status: 200 });
    if (u.includes('/api/leaderboard')) return new Response(JSON.stringify(STANDINGS), { status: 200 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    if (body.method === 'getAccountInfo') {
      return new Response(JSON.stringify({ result: { value: null } }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as unknown as typeof fetch;
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

const api = '--api';
const base = 'http://probatio.test';

describe('probatio cli', () => {
  it('prints help with no command', async () => {
    const { io, out } = capture();
    expect(await run([], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage/);
  });

  it('verify needs a wallet', async () => {
    const { io, err } = capture();
    expect(await run(['verify', '--rpc', 'http://rpc'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/needs a wallet/);
  });

  it('verify needs an rpc endpoint', async () => {
    const { io, err } = capture();
    expect(await run(['verify', WALLET, api, base], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/rpc/);
  });

  it('verify reports a not-verified record and exits 1', async () => {
    const { io, out } = capture();
    const code = await run(['verify', WALLET, '--rpc', 'http://rpc', api, base], io, mockFetch());
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/NOT VERIFIED/);
  });

  it('reads a record', async () => {
    const { io, out } = capture();
    expect(await run(['record', WALLET, api, base], io, mockFetch())).toBe(0);
    expect(out.join('\n')).toMatch(/ace/);
    expect(out.join('\n')).toMatch(/season 1/);
  });

  it('reads standings', async () => {
    const { io, out } = capture();
    expect(await run(['standings', api, base], io, mockFetch())).toBe(0);
    expect(out.join('\n')).toMatch(/Season 1/);
  });

  it('rejects an unknown command', async () => {
    const { io, err } = capture();
    expect(await run(['frobnicate'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/unknown command/);
  });

  it('supports --json', async () => {
    const { io, out } = capture();
    expect(await run(['record', WALLET, api, base, '--json'], io, mockFetch())).toBe(0);
    expect(JSON.parse(out.join('\n')).trader).toBe(WALLET);
  });
});
