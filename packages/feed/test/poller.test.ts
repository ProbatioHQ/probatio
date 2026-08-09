import { describe, expect, it } from 'vitest';
import type { PoolReader, Resolution } from '@probatio/pools';
import { PoolPoller } from '../src/poller';
import { RequestBudget } from '../src/budget';
import { SubscriptionRegistry } from '../src/registry';

const NOW = 1_000_000;

function resolution(mint: string, solReserve = 31_000_000_000n): Resolution {
  return {
    mint,
    venue: { kind: 'pumpfun-curve', curveAddress: `curve-${mint}` },
    pool: {
      mint,
      solReserve,
      tokenReserve: 1_000_000_000_000_000n,
      deliverableTokens: 700_000_000_000_000n,
      tokenDecimals: 6,
      fees: { protocolBps: 95, creatorBps: 30, lpBps: 0 },
      source: 'pumpfun-curve',
      slot: 1,
    },
    slot: 1,
  };
}

function stubReader(behaviour: (mint: string) => Promise<Resolution>): {
  reader: PoolReader;
  calls: string[];
} {
  const calls: string[] = [];
  const reader = {
    async resolve(mint: string) {
      calls.push(mint);
      return behaviour(mint);
    },
  };
  return { reader: reader as unknown as PoolReader, calls };
}

describe('RequestBudget', () => {
  it('starts with a full burst', () => {
    const budget = new RequestBudget({ requestsPerSecond: 5 }, 0);
    expect(budget.available(0)).toBe(5);
  });

  it('grants no more than it has', () => {
    const budget = new RequestBudget({ requestsPerSecond: 5 }, 0);
    expect(budget.take(100, 0)).toBe(5);
    expect(budget.take(1, 0)).toBe(0);
  });

  it('refills over time', () => {
    const budget = new RequestBudget({ requestsPerSecond: 10 }, 0);
    budget.take(10, 0);
    expect(budget.take(5, 500)).toBe(5);
  });

  it('does not accumulate beyond the burst', () => {
    // A quiet hour must not buy an hour's worth of requests to fire at once.
    const budget = new RequestBudget({ requestsPerSecond: 5 }, 0);
    expect(budget.available(3_600_000)).toBe(5);
  });

  it('rejects a non-positive rate', () => {
    expect(() => new RequestBudget({ requestsPerSecond: 0 })).toThrow();
  });
});

describe('PoolPoller', () => {
  it('does nothing when nothing is subscribed', async () => {
    const registry = new SubscriptionRegistry();
    const { reader, calls } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 10 }, NOW);

    const result = await poller.tick(NOW);
    expect(result.polled).toEqual([]);
    expect(result.requestsSpent).toBe(0);
    // The core promise of demand-driven polling: an idle system costs nothing.
    expect(calls).toEqual([]);
  });

  it('reads a subscribed mint and produces an observation', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW);
    const { reader } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 10 }, NOW);

    const result = await poller.tick(NOW);
    expect(result.polled).toEqual(['A']);
    expect(result.observations.get('A')!.price).toBeGreaterThan(0n);
  });

  it('records no volume for a poll', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW);
    const { reader } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 10 }, NOW);

    // A poll observes a price; it is not a trade. Counting it as volume would
    // inflate every chart with activity that never happened.
    const result = await poller.tick(NOW);
    expect(result.observations.get('A')!.volumeLamports).toBe(0n);
  });

  it('does not re-read a mint before its interval elapses', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW);
    const { reader, calls } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 100 }, NOW);

    await poller.tick(NOW);
    await poller.tick(NOW + 100);
    expect(calls).toEqual(['A']);
  });

  it('reads again once the interval has passed', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW);
    const { reader, calls } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 100 }, NOW);

    await poller.tick(NOW);
    await poller.tick(NOW + 5_000);
    expect(calls).toEqual(['A', 'A']);
  });

  it('stops spending once the budget runs out', async () => {
    const registry = new SubscriptionRegistry();
    for (let i = 0; i < 200; i += 1) registry.lease(`m${i}`, 'viewing', NOW);

    const { reader, calls } = stubReader(async (mint) => resolution(mint));
    // One request per second, ten mints per batch: ten mints affordable.
    const poller = new PoolPoller(
      reader,
      registry,
      { requestsPerSecond: 1, burst: 1, batchSize: 10 },
      NOW,
    );

    const result = await poller.tick(NOW);
    expect(calls).toHaveLength(10);
    expect(result.requestsSpent).toBe(1);
    // The ceiling has to hold no matter how many people show up.
    expect(result.budgetLimited).toBe(true);
  });

  it('reports when demand, not budget, set the pace', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW);
    const { reader } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 100 }, NOW);

    expect((await poller.tick(NOW)).budgetLimited).toBe(false);
  });

  it('survives one token failing without losing the batch', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('good', 'viewing', NOW);
    registry.lease('bad', 'viewing', NOW);

    const { reader } = stubReader(async (mint) => {
      if (mint === 'bad') throw new Error('no curve');
      return resolution(mint);
    });
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 10 }, NOW);

    const result = await poller.tick(NOW);
    expect(result.polled).toEqual(['good']);
    expect(result.failed).toEqual(['bad']);
    expect(result.observations.has('good')).toBe(true);
  });

  it('backs a failing token off rather than retrying it every tick', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('bad', 'viewing', NOW);

    const { reader, calls } = stubReader(async () => {
      throw new Error('no curve');
    });
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 100 }, NOW);

    await poller.tick(NOW);
    await poller.tick(NOW + 2_500);
    // Still inside the doubled interval, so no second attempt.
    expect(calls).toHaveLength(1);
  });

  it('reports a graduated token with no live pool', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW);
    const { reader } = stubReader(async (mint) => ({
      mint,
      venue: { kind: 'unlisted' as const },
      pool: null,
      slot: 1,
    }));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 10 }, NOW);

    const result = await poller.tick(NOW);
    expect(result.unlisted).toEqual(['A']);
    expect(result.observations.size).toBe(0);
  });

  it('drops expired leases before spending anything on them', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('A', 'viewing', NOW, 1_000);
    const { reader, calls } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(reader, registry, { requestsPerSecond: 10 }, NOW);

    await poller.tick(NOW + 5_000);
    expect(calls).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('reads held positions before watchlist entries under a tight budget', async () => {
    const registry = new SubscriptionRegistry();
    registry.lease('watched', 'watching', NOW);
    registry.setHeld(['held'], NOW);

    const { reader, calls } = stubReader(async (mint) => resolution(mint));
    const poller = new PoolPoller(
      reader,
      registry,
      { requestsPerSecond: 1, burst: 1, batchSize: 1 },
      NOW,
    );

    await poller.tick(NOW);
    expect(calls).toEqual(['held']);
  });
});
