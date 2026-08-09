import { describe, expect, it } from 'vitest';
import type { PoolReader, Resolution } from '@probatio/pools';
import { PoolPoller } from '../src/poller';
import { SubscriptionRegistry } from '../src/registry';

/**
 * The cost model, as a test.
 *
 * C8 exists for one reason: to keep the RPC bill bounded. A claim like that is
 * worth nothing unless it is measured, so these simulate load and assert the
 * request rate against a hard ceiling.
 *
 * The number that matters is requests per month, because that is what a
 * provider actually charges for.
 */

function resolution(mint: string): Resolution {
  return {
    mint,
    venue: { kind: 'pumpfun-curve', curveAddress: `curve-${mint}` },
    pool: {
      mint,
      solReserve: 31_000_000_000n,
      tokenReserve: 1_000_000_000_000_000n,
      deliverableTokens: 700_000_000_000_000n,
      tokenDecimals: 6,
      feeBps: 100,
      source: 'pumpfun-curve',
      slot: 1,
    },
    slot: 1,
  };
}

const reader = {
  async resolve(mint: string) {
    return resolution(mint);
  },
} as unknown as PoolReader;

/**
 * The bound a token bucket actually guarantees.
 *
 * Sustained rate times elapsed time, plus one burst. The burst is deliberate —
 * it lets a quiet system respond immediately when someone opens a token — so
 * asserting against the rate alone would be asserting the burst away.
 */
function ceilingFor(requestsPerSecond: number, seconds: number, burst?: number): number {
  return requestsPerSecond * seconds + (burst ?? Math.max(1, Math.ceil(requestsPerSecond)));
}

/** Run the poller over simulated time and total up what it spent. */

async function simulate(options: {
  tokens: number;
  heldTokens?: number;
  minutes: number;
  requestsPerSecond: number;
  batchSize?: number;
  tickMs?: number;
}): Promise<{
  requests: number;
  requestsPerSecond: number;
  requestsPerMonth: number;
  seconds: number;
}> {
  const registry = new SubscriptionRegistry();
  const tickMs = options.tickMs ?? 500;
  const start = 1_000_000;

  const poller = new PoolPoller(
    reader,
    registry,
    {
      requestsPerSecond: options.requestsPerSecond,
      batchSize: options.batchSize ?? 20,
    },
    start,
  );

  const held = Array.from({ length: options.heldTokens ?? 0 }, (_, i) => `held${i}`);
  if (held.length) registry.setHeld(held, start);

  let requests = 0;
  const durationMs = options.minutes * 60_000;

  for (let elapsed = 0; elapsed <= durationMs; elapsed += tickMs) {
    const now = start + elapsed;

    // Clients renew their leases while they are still looking.
    for (let i = 0; i < options.tokens; i += 1) {
      registry.lease(`view${i}`, 'viewing', now);
    }

    const result = await poller.tick(now);
    requests += result.requestsSpent;
  }

  const seconds = durationMs / 1000;
  const perSecond = requests / seconds;
  return {
    requests,
    requestsPerSecond: perSecond,
    requestsPerMonth: Math.round(perSecond * 60 * 60 * 24 * 30),
    seconds,
  };
}

describe('an idle system', () => {
  it('costs nothing', async () => {
    const result = await simulate({ tokens: 0, minutes: 10, requestsPerSecond: 10 });
    expect(result.requests).toBe(0);
  });
});

describe('a single user watching one token', () => {
  it('polls at the interval, not as fast as it can', async () => {
    const result = await simulate({ tokens: 1, minutes: 10, requestsPerSecond: 10 });

    // Viewing wants a reading every 2s, so ten minutes is about 300 reads —
    // not the 1,200 a naive loop at the tick rate would make.
    expect(result.requests).toBeGreaterThan(250);
    expect(result.requests).toBeLessThan(320);
  });
});

describe('realistic load', () => {
  it('stays under the ceiling with 50 tokens in view', async () => {
    const result = await simulate({
      tokens: 50,
      heldTokens: 10,
      minutes: 10,
      requestsPerSecond: 10,
      batchSize: 20,
    });

    expect(result.requests).toBeLessThanOrEqual(ceilingFor(10, result.seconds));
    // Well inside a free tier's monthly allowance.
    expect(result.requestsPerMonth).toBeLessThan(30_000_000);
  });

  it('holds the ceiling under load far beyond what is expected', async () => {
    // 2,000 tokens in view at once is not a realistic session — it is someone
    // trying to make us pay. The ceiling has to hold anyway.
    const result = await simulate({
      tokens: 500,
      heldTokens: 100,
      minutes: 5,
      requestsPerSecond: 10,
      batchSize: 20,
    });

    expect(result.requests).toBeLessThanOrEqual(ceilingFor(10, result.seconds));
  });
});

describe('the ceiling', () => {
  it('is never exceeded regardless of demand', async () => {
    for (const tokens of [10, 100, 1_000]) {
      const result = await simulate({
        tokens,
        minutes: 3,
        requestsPerSecond: 5,
        batchSize: 20,
      });
      expect(result.requests).toBeLessThanOrEqual(ceilingFor(5, result.seconds));
    }
  });

  it('grows sublinearly with demand and then stops', async () => {
    // The property that makes this affordable. Cost does rise with demand —
    // it would be broken if it did not — but batching flattens the curve and
    // the ceiling ends it. Twenty times the tokens is nowhere near twenty
    // times the bill.
    const small = await simulate({ tokens: 20, minutes: 5, requestsPerSecond: 4, batchSize: 20 });
    const large = await simulate({ tokens: 400, minutes: 5, requestsPerSecond: 4, batchSize: 20 });

    expect(small.requests).toBeLessThanOrEqual(ceilingFor(4, small.seconds));
    expect(large.requests).toBeLessThanOrEqual(ceilingFor(4, large.seconds));

    const demandRatio = 400 / 20;
    const costRatio = large.requests / small.requests;
    expect(costRatio).toBeGreaterThan(1);
    expect(costRatio).toBeLessThan(demandRatio / 2);
  });
});
