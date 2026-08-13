import { describe, expect, it } from 'vitest';
import { run, type CliIo } from '../src/cli';

const WALLET = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';

const RECORD = {
  trader: WALLET,
  name: 'ace',
  display: 'ace',
  exists: true,
  seasons: [
    { seasonId: 1, ranked: true, freePlay: false, trades: 9, roundTrips: 4, winRateBps: 5600, netPnl: '1200', committedBatches: 2, committedTrades: 9 },
  ],
  proof: `/api/proof?trader=${WALLET}`,
};

const STANDINGS = {
  season: { ordinal: 1, name: 'Season 1', status: 'running', entrants: 1, potLamports: '0', scoring: 'highest_return' },
  standings: [{ rank: 1, trader: WALLET, name: 'ace', returnBps: 4200, finalEquity: '14', startingBalance: '10', tradeCount: 9, payoutLamports: '0' }],
  total: 1,
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
    const text = out.join('\n');
    expect(text).toMatch(/ace/);
    expect(text).toMatch(/season 1/);
    // The profile fields must actually render: a drift between these and the
    // endpoint once printed "season undefined: NaN%".
    expect(text).toMatch(/9 trade\(s\)/);
    expect(text).toMatch(/56\.0% win/);
    expect(text).not.toMatch(/undefined|NaN/);
  });

  it('reads standings', async () => {
    const { io, out } = capture();
    expect(await run(['standings', api, base], io, mockFetch())).toBe(0);
    expect(out.join('\n')).toMatch(/Season 1/);
  });

  it('dumps the raw proof bundle', async () => {
    const { io, out } = capture();
    expect(await run(['proof', WALLET, api, base], io, mockFetch())).toBe(0);
    expect(JSON.parse(out.join('\n')).trader).toBe(WALLET);
  });

  it('proof needs a wallet', async () => {
    const { io, err } = capture();
    expect(await run(['proof'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/needs a wallet/);
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

  it('accepts the --flag=value form', async () => {
    const { io, out } = capture();
    expect(await run(['record', WALLET, `--api=${base}`], io, mockFetch())).toBe(0);
    expect(out.join('\n')).toMatch(/ace/);
  });

  it('rejects a flag whose value is another flag instead of swallowing it', async () => {
    const { io, err } = capture();
    // --api used to consume --json as its value; now it is a usage error.
    expect(await run(['record', WALLET, '--api', '--json'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/--api needs a value/);
  });

  it('rejects a non-numeric --limit instead of sending NaN', async () => {
    const { io, err } = capture();
    expect(await run(['standings', api, base, '--limit', 'foo'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/--limit must be a non-negative integer/);
  });

  it('rejects a negative --season', async () => {
    const { io, err } = capture();
    expect(await run(['verify', WALLET, '--rpc', 'http://rpc', '--season', '-1'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/--season must be a non-negative integer/);
  });

  it('rejects an unknown option', async () => {
    const { io, err } = capture();
    expect(await run(['record', WALLET, '--nope'], io, mockFetch())).toBe(2);
    expect(err.join('\n')).toMatch(/unknown option: --nope/);
  });
});
