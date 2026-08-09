import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '@probatio/sim';
import { RpcClient } from '@probatio/pools';
import { collectEvents } from '../src/collect';
import { combine, replay, type ValidationReport } from '../src/replay';
import { formatReport } from '../src/format';

/**
 * The gate, measured against real history.
 *
 * Everything downstream — seasons, the leaderboard, capital allocation —
 * assumes a simulated fill matches what the chain did. This is where that
 * assumption is tested rather than asserted.
 *
 *   RPC_VALIDATION=1 npx vitest run packages/validation/test/mainnet.test.ts
 *
 * The public endpoint rate-limits hard, so the sample here is deliberately
 * modest. A real run before launch wants a paid endpoint and thousands of
 * trades; the harness is the same either way.
 */

const ENABLED = process.env['RPC_VALIDATION'] === '1';
const RPC_URL = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const PER_TOKEN = Number(process.env['REPLAY_TXS'] ?? '120');

const MINTS = [
  'BepXrvvfoFohZBSRTLnesHMpjy7EkRjyUVAA39rZpump',
  '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump',
];

describe.skipIf(!ENABLED)('the fill engine against real history', () => {
  const rpc = new RpcClient({
    endpoint: RPC_URL,
    timeoutMs: 30_000,
    // Paced rather than merely retried. The public endpoint refuses a burst
    // outright, and backoff only turns those refusals into waiting.
    minIntervalMs: Number(process.env['RPC_INTERVAL_MS'] ?? '110'),
    maxRetries: 6,
  });

  it('reproduces real fills', async () => {
    const reports: ValidationReport[] = [];

    for (const mint of MINTS) {
      const ordered = await collectEvents(rpc, mint, {
        maxTransactions: PER_TOKEN,
        concurrency: 2,
      });
      const report = replay(mint, ordered, ENGINE_VERSION);
      reports.push(report);
      console.log(`\n${formatReport(report)}\n`);
    }

    const total = combine('all tokens', reports);
    console.log(`\n=== combined ===\n${formatReport(total)}\n`);

    expect(total.samples).toBeGreaterThan(50);

    // Both directions, or half the engine is unmeasured.
    expect(total.buys).toBeGreaterThan(0);
    expect(total.sells).toBeGreaterThan(0);

    // The plan set 1-2% as the bar. The engine reproduces the program's own
    // arithmetic, so anything near that would mean the formula is wrong rather
    // than imprecise — the real expectation is exact.
    expect(total.medianErrorBps).toBe(0);
    expect(total.p95ErrorBps).toBeLessThanOrEqual(1);

    // Pairs are only scored once reserve arithmetic proves they are genuinely
    // consecutive, so a stray outlier means a real mismatch, not a gap.
    expect(total.maxErrorBps).toBeLessThanOrEqual(10);

    // Near-total exactness is the actual claim being made.
    expect(total.exactRate).toBeGreaterThan(0.95);
  }, 900_000);
});
