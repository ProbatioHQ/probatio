import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Prices for watched tokens, read from pump.fun rather than the chain.
 *
 * These cover the half of the job that was missing rather than wrong. The first
 * version published to the live stream and stopped there, which fixed the bar in
 * progress and nothing else: every other figure on a token page is read back out
 * of the candle store, so the number above the chart sat still for minutes while
 * the bar under it moved, and each candle poll stamped the stale close back over
 * the live one. On screen that was a price flickering between two values.
 */

const published: Array<{ mint: string; price: bigint; at: number }> = [];
const ingested: Array<{ mint: string; observations: readonly unknown[] }> = [];
let watched: string[] = [];
let chainListener: ((price: Record<string, unknown>) => void) | null = null;

vi.mock('../price-stream', () => ({
  publishPolledPrice: (mint: string, price: bigint, at: number) =>
    void published.push({ mint, price, at }),
  onLivePrice: (listener: (price: Record<string, unknown>) => void) => {
    chainListener = listener;
    return () => {
      chainListener = null;
    };
  },
}));
vi.mock('../trade-candles', () => ({
  ingestObservations: (mint: string, observations: readonly unknown[]) =>
    void ingested.push({ mint, observations }),
}));
vi.mock('../watched', () => ({ recentlyViewed: () => watched }));

const MINT = 'D3KxoUnQdZZUnQcpmxb9Ktb26rDndURseog6DPsVpump';
const NOW = 1_787_500_000_000;
const CLOSE = 0.0000009052586372470593;

/** How often the poller asks, and how long it stands off the subscription. */
const INTERVAL_MS = 6_000;
const DEFER_MS = 20_000;

/** One 1m candle, shaped the way pump.fun's swap-api shapes them. */
function candle(close: number, at = NOW): Record<string, unknown> {
  return { timestamp: at, open: close, high: close, low: close, close };
}

function respond(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

/**
 * Let the work a pass started finish.
 *
 * Every await in it is on a mock that resolves immediately, so nudging the clock
 * drains it. Polling for a result instead would pass by timing out on the cases
 * that expect nothing written, which is the one shape of test that cannot fail.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

/**
 * A poller with no memory of the last test.
 *
 * The module keeps its state on `globalThis` so a route and instrumentation
 * share one poller, which means resetting the module is not enough to give a
 * test a clean one — the symbol has to go too.
 */
async function fresh(): Promise<() => void> {
  vi.resetModules();
  delete (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('probatio.polled-prices')
  ];
  const { startPolledPrices } = await import('../polled-prices');
  return startPolledPrices;
}

/** One pass, driven through the only exported entry point. */
async function runOnePass(): Promise<void> {
  (await fresh())();
  await settle();
}

beforeEach(() => {
  published.length = 0;
  ingested.length = 0;
  watched = [MINT];
  chainListener = null;
  vi.useFakeTimers({ now: NOW });
  vi.stubGlobal('fetch', vi.fn(async () => respond([candle(CLOSE)])));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('polled prices', () => {
  it('records the price it publishes as a candle', async () => {
    await runOnePass();

    expect(published).toHaveLength(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.mint).toBe(MINT);

    // The regression: a published price that never reached the store left the
    // figure above the chart on an eight-minute-old close while the bar moved.
    const [observation] = ingested[0]!.observations as Array<{
      timestamp: number;
      price: bigint;
      volumeLamports: bigint;
    }>;
    expect(observation!.price).toBe(published[0]!.price);
    expect(observation!.timestamp).toBe(Math.floor(NOW / 1_000));
  });

  it('claims no volume, because a price observed is not a trade seen', async () => {
    await runOnePass();

    const [observation] = ingested[0]!.observations as Array<{ volumeLamports: bigint }>;
    expect(observation!.volumeLamports).toBe(0n);
  });

  it('converts a SOL close onto the price axis the rest of the site uses', async () => {
    // SOL per whole token, into lamports per base unit scaled by 1e18. Measured
    // against the store's own candles for a live token: agrees to within 0.11%.
    await runOnePass();
    expect(published[0]!.price).toBe(BigInt(Math.round(CLOSE * 1e21)));
  });

  it('writes nothing when pump.fun has nothing to give', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond([])));
    await runOnePass();

    expect(published).toHaveLength(0);
    // A chart left as it was beats a chart filled with a price nobody quoted.
    expect(ingested).toHaveLength(0);
  });

  it('writes nothing when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(null, false)));
    await runOnePass();

    expect(published).toHaveLength(0);
    expect(ingested).toHaveLength(0);
  });

  it('defers to the chain subscription while it is still speaking', async () => {
    (await fresh())();
    await settle();
    expect(published).toHaveLength(1);

    published.length = 0;
    ingested.length = 0;

    // The subscription speaks. It is the better source, so the pass due next
    // must leave this mint alone rather than write a second opinion over it.
    chainListener?.({ source: 'chain', mint: MINT, at: Date.now() });
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(published).toHaveLength(0);
    expect(ingested).toHaveLength(0);
  });

  it('takes over again once the subscription has gone quiet', async () => {
    (await fresh())();
    await settle();
    chainListener?.({ source: 'chain', mint: MINT, at: Date.now() });

    published.length = 0;
    ingested.length = 0;

    // Deferring must be a pause, not a handover. A subscription that dies would
    // otherwise silence the only source left.
    await vi.advanceTimersByTimeAsync(DEFER_MS + INTERVAL_MS);

    expect(published.length).toBeGreaterThan(0);
    expect(ingested.length).toBeGreaterThan(0);
  });

  it('prices at most eight tokens in one pass', async () => {
    watched = Array.from({ length: 20 }, (_, index) => `mint${index}`);
    await runOnePass();

    // A request each against somebody else's service, so the watched set is
    // capped rather than trusted to stay small.
    expect(published).toHaveLength(8);
    expect(ingested).toHaveLength(8);
  });
});
