import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When a chart stops saying it is still reading from the chain.
 *
 * The fetched history and the chain walk are one job to this module and two
 * things to a reader: the fetch puts a whole chart on screen in seconds, the
 * walk then spends minutes refining its recent end. Reporting the job as
 * in-flight until both were done left every chart on the site showing a
 * sentence about the chain with a perfectly good chart sitting underneath it.
 */

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

let historyCandles = 0;
let walkStarted = 0;
let releaseWalk: (() => void) | null = null;

vi.mock('../db', () => ({ db: async () => ({}) }));
vi.mock('../env', () => ({ hasDedicatedRpc: () => true, rpcEndpoint: () => 'https://rpc.test' }));
vi.mock('../rpc', () => ({
  resolveMint: async () => ({
    slot: 1,
    pool: { solReserve: 30_000_000_000n, tokenReserve: 1_000_000_000_000n },
    venue: { kind: 'pumpfun-curve' },
  }),
}));
vi.mock('../pumpfun-history', () => ({ splicePumpfunHistory: async () => historyCandles }));
vi.mock('../gecko-history', () => ({ spliceGeckoHistory: async () => 0 }));
vi.mock('@probatio/db', () => ({
  getBackfill: async () => null,
  recordBackfill: async () => undefined,
  writeCandles: async () => undefined,
}));
vi.mock('@probatio/validation', () => ({ collectPoolSwaps: async () => [] }));
vi.mock('@probatio/pools', async (original) => ({
  ...(await original<typeof import('@probatio/pools')>()),
  RpcClient: class {},
  PoolReader: class {},
}));

/*
 * The walk, held open on purpose.
 *
 * This is the whole point. Under the shared credit budget a transaction read
 * costs ten credits and waits four seconds, so a walk of four hundred takes
 * half an hour. Everything asserted below is about what the chart says during
 * that half hour.
 */
vi.mock('@probatio/candles', async (original) => ({
  ...(await original<typeof import('@probatio/candles')>()),
  backfillFromCurve: async () => {
    walkStarted += 1;
    await new Promise<void>((resolve) => {
      releaseWalk = resolve;
    });
    return { observations: [], truncated: false };
  },
}));

beforeEach(() => {
  historyCandles = 0;
  walkStarted = 0;
  releaseWalk = null;
  vi.resetModules();
});

describe('what the chart reports while it fills', () => {
  it('is drawable as soon as there is history, without waiting for the walk', async () => {
    historyCandles = 120;
    const { backfillChart, backfillInFlight } = await import('../chart-backfill');

    backfillChart(MINT);
    // Nothing has run yet: the flag is set synchronously so a poll arriving in
    // the same tick does not start a second walk.
    expect(backfillInFlight(MINT)).toBe(true);

    // Let the fetched history land. The walk is still going and will be for
    // half an hour, which is exactly the situation this is about.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(walkStarted).toBe(1);
    expect(backfillInFlight(MINT)).toBe(false);

    releaseWalk?.();
  });

  /*
   * Nothing to draw is still nothing to draw. A token pump.fun cannot serve
   * has only the walk, and saying so is honest rather than showing an empty
   * chart as though it were finished.
   */
  it('keeps saying so when no history could be fetched', async () => {
    historyCandles = 0;
    const { backfillChart, backfillInFlight } = await import('../chart-backfill');

    backfillChart(MINT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(walkStarted).toBe(1);
    expect(backfillInFlight(MINT)).toBe(true);

    releaseWalk?.();
  });
});
