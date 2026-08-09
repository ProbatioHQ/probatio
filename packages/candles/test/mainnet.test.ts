import { describe, expect, it } from 'vitest';
import { RpcClient, bondingCurveAddress } from '@probatio/pools';
import { backfillFromCurve } from '../src/backfill';
import { buildCandles, fillGaps } from '../src/candles';
import { priceToNumber } from '../src/price';

/**
 * Reconstructing a real token's chart from chain.
 *
 * The offline tests prove the aggregation is correct given observations. This
 * proves the observations themselves are real: that the event layout holds
 * against live transactions, that the timestamps line up, and that the prices
 * that come out describe a market rather than noise.
 *
 * Skipped by default. To run:
 *
 *   RPC_VALIDATION=1 npx vitest run packages/candles/test/mainnet.test.ts
 */

const ENABLED = process.env['RPC_VALIDATION'] === '1';
const RPC_URL = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

describe.skipIf(!ENABLED)('backfill against mainnet', () => {
  const rpc = new RpcClient({ endpoint: RPC_URL, timeoutMs: 30_000 });

  it('reconstructs a chart from real trade history', async () => {
    const result = await backfillFromCurve(rpc, MINT, bondingCurveAddress(MINT), {
      maxTransactions: 12,
      concurrency: 2,
    });

    expect(result.eventsFound).toBeGreaterThan(0);
    expect(result.observations.length).toBeGreaterThan(0);

    // Chronological, oldest first.
    for (let i = 1; i < result.observations.length; i += 1) {
      expect(result.observations[i]!.timestamp).toBeGreaterThanOrEqual(
        result.observations[i - 1]!.timestamp,
      );
    }

    for (const observation of result.observations) {
      expect(observation.price).toBeGreaterThan(0n);
      // A live memecoin sits far below 1 lamport per base unit. Anything above
      // that would mean the reserves were read the wrong way round.
      expect(priceToNumber(observation.price)).toBeLessThan(1);
      // Timestamps land in a plausible window rather than at the epoch.
      expect(observation.timestamp).toBeGreaterThan(1_700_000_000);
      expect(observation.timestamp).toBeLessThan(2_000_000_000);
    }

    const candles = buildCandles(result.observations, 'm1');
    expect(candles.length).toBeGreaterThan(0);

    for (const candle of candles) {
      // The invariants that make a candle a candle. These would break
      // immediately if high and low were tracked wrongly.
      expect(candle.high).toBeGreaterThanOrEqual(candle.open);
      expect(candle.high).toBeGreaterThanOrEqual(candle.close);
      expect(candle.high).toBeGreaterThanOrEqual(candle.low);
      expect(candle.low).toBeLessThanOrEqual(candle.open);
      expect(candle.low).toBeLessThanOrEqual(candle.close);
      expect(candle.trades).toBeGreaterThan(0);
      expect(candle.openTime % 60).toBe(0);
    }
  }, 180_000);

  it('produces a continuous series once gaps are filled', async () => {
    const result = await backfillFromCurve(rpc, MINT, bondingCurveAddress(MINT), {
      maxTransactions: 12,
      concurrency: 2,
    });

    const filled = fillGaps(buildCandles(result.observations, 'm1'), 'm1');
    for (let i = 1; i < filled.length; i += 1) {
      // Every step is exactly one bucket — no holes for a chart to jump across.
      expect(filled[i]!.openTime - filled[i - 1]!.openTime).toBe(60);
    }
  }, 180_000);
});
