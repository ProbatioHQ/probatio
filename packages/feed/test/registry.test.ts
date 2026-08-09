import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_MS,
  MAX_BACKOFF_MS,
  REASON_INTERVAL_MS,
  SubscriptionRegistry,
} from '../src/registry';

const A = 'mintA';
const B = 'mintB';
const C = 'mintC';
const NOW = 1_000_000;

let registry: SubscriptionRegistry;

beforeEach(() => {
  registry = new SubscriptionRegistry();
});

describe('leases', () => {
  it('starts tracking a mint', () => {
    registry.lease(A, 'viewing', NOW);
    expect(registry.tracked()).toEqual([A]);
  });

  it('renews rather than duplicating', () => {
    registry.lease(A, 'viewing', NOW);
    registry.lease(A, 'viewing', NOW + 1_000);
    expect(registry.size).toBe(1);
    expect(registry.prune(NOW + DEFAULT_LEASE_MS + 500)).toEqual([]);
  });

  it('expires without a renewal', () => {
    // The whole reason leases exist: a browser tab that closes without telling
    // us must stop costing money on its own.
    registry.lease(A, 'viewing', NOW);
    expect(registry.prune(NOW + DEFAULT_LEASE_MS + 1)).toEqual([A]);
    expect(registry.size).toBe(0);
  });

  it('keeps a mint alive while any reason survives', () => {
    registry.lease(A, 'viewing', NOW, 1_000);
    registry.lease(A, 'watching', NOW, 10_000);
    expect(registry.prune(NOW + 2_000)).toEqual([]);
    expect(registry.tracked()).toEqual([A]);
  });

  it('can be released early', () => {
    registry.lease(A, 'viewing', NOW);
    registry.release(A, 'viewing');
    expect(registry.size).toBe(0);
  });

  it('ignores a release for something untracked', () => {
    expect(() => registry.release('nope', 'viewing')).not.toThrow();
  });
});

describe('held positions', () => {
  it('are tracked without a lease', () => {
    registry.setHeld([A], NOW);
    expect(registry.tracked()).toEqual([A]);
  });

  it('never expire', () => {
    // A position's PnL must not freeze because a client stopped talking.
    registry.setHeld([A], NOW);
    expect(registry.prune(NOW + DEFAULT_LEASE_MS * 100)).toEqual([]);
    expect(registry.tracked()).toEqual([A]);
  });

  it('are dropped when the position closes', () => {
    registry.setHeld([A, B], NOW);
    registry.setHeld([A], NOW);
    expect(registry.tracked()).toEqual([A]);
  });

  it('survive losing a lease if still held', () => {
    registry.setHeld([A], NOW);
    registry.lease(A, 'viewing', NOW, 1_000);
    registry.prune(NOW + 2_000);
    expect(registry.tracked()).toEqual([A]);
  });

  it('get the tightest interval', () => {
    registry.setHeld([A], NOW);
    expect(registry.intervalFor(A, NOW)).toBe(REASON_INTERVAL_MS.holding);
  });
});

describe('intervals', () => {
  it('differ by reason', () => {
    registry.lease(A, 'viewing', NOW);
    registry.lease(B, 'watching', NOW);
    expect(registry.intervalFor(A, NOW)).toBe(REASON_INTERVAL_MS.viewing);
    expect(registry.intervalFor(B, NOW)).toBe(REASON_INTERVAL_MS.watching);
  });

  it('take the tightest of several reasons', () => {
    registry.lease(A, 'watching', NOW);
    registry.lease(A, 'viewing', NOW);
    expect(registry.intervalFor(A, NOW)).toBe(REASON_INTERVAL_MS.viewing);
  });

  it('are infinite for an untracked mint', () => {
    expect(registry.intervalFor('unknown', NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignore an expired lease', () => {
    registry.lease(A, 'viewing', NOW, 1_000);
    registry.setHeld([A], NOW);
    // Still held, so still finite — but the expired viewing lease no longer
    // has a say.
    expect(registry.intervalFor(A, NOW + 5_000)).toBe(REASON_INTERVAL_MS.holding);
  });
});

describe('error backoff', () => {
  it('widens the interval as failures repeat', () => {
    registry.lease(A, 'viewing', NOW);
    const base = registry.intervalFor(A, NOW);

    registry.markError(A, NOW);
    expect(registry.intervalFor(A, NOW)).toBe(base * 2);

    registry.markError(A, NOW);
    expect(registry.intervalFor(A, NOW)).toBe(base * 4);
  });

  it('caps the backoff', () => {
    registry.lease(A, 'viewing', NOW);
    for (let i = 0; i < 20; i += 1) registry.markError(A, NOW);
    expect(registry.intervalFor(A, NOW)).toBe(MAX_BACKOFF_MS);
  });

  it('resets on a successful poll', () => {
    registry.lease(A, 'viewing', NOW);
    registry.markError(A, NOW);
    registry.markPolled(A, NOW);
    expect(registry.intervalFor(A, NOW)).toBe(REASON_INTERVAL_MS.viewing);
  });
});

describe('selectBatch', () => {
  it('returns nothing when nothing is due', () => {
    registry.lease(A, 'viewing', NOW);
    registry.markPolled(A, NOW);
    // A quiet system must make no requests at all.
    expect(registry.selectBatch(NOW + 100, 10)).toEqual([]);
  });

  it('returns a mint that has never been polled', () => {
    registry.lease(A, 'viewing', NOW);
    expect(registry.selectBatch(NOW, 10)).toEqual([A]);
  });

  it('respects the limit', () => {
    registry.lease(A, 'viewing', NOW);
    registry.lease(B, 'viewing', NOW);
    registry.lease(C, 'viewing', NOW);
    expect(registry.selectBatch(NOW, 2)).toHaveLength(2);
  });

  it('returns nothing for a zero or negative limit', () => {
    registry.lease(A, 'viewing', NOW);
    expect(registry.selectBatch(NOW, 0)).toEqual([]);
    expect(registry.selectBatch(NOW, -1)).toEqual([]);
  });

  it('prioritises held positions over merely viewed ones', () => {
    registry.lease(A, 'watching', NOW);
    registry.lease(B, 'viewing', NOW);
    registry.setHeld([C], NOW);

    expect(registry.selectBatch(NOW, 1)).toEqual([C]);
    expect(registry.selectBatch(NOW, 2)).toEqual([C, B]);
  });

  it('breaks ties by how overdue each is', () => {
    registry.lease(A, 'viewing', NOW);
    registry.lease(B, 'viewing', NOW);
    registry.markPolled(A, NOW);
    registry.markPolled(B, NOW - 10_000);

    // B has been waiting far longer, so the budget buys more by reading it.
    expect(registry.selectBatch(NOW + REASON_INTERVAL_MS.viewing, 1)).toEqual([B]);
  });

  it('waits out an error backoff before offering a mint again', () => {
    registry.lease(A, 'viewing', NOW);
    registry.markError(A, NOW);

    expect(registry.selectBatch(NOW + REASON_INTERVAL_MS.viewing, 10)).toEqual([]);
    expect(registry.selectBatch(NOW + REASON_INTERVAL_MS.viewing * 2, 10)).toEqual([A]);
  });

  it('skips mints whose leases have all expired', () => {
    registry.lease(A, 'viewing', NOW, 1_000);
    expect(registry.selectBatch(NOW + 5_000, 10)).toEqual([]);
  });
});

describe('capacity', () => {
  it('sheds the lowest-priority tokens when full', () => {
    const small = new SubscriptionRegistry({ maxTracked: 2 });
    small.lease(A, 'watching', NOW);
    small.lease(B, 'viewing', NOW);
    small.lease(C, 'viewing', NOW);

    expect(small.size).toBe(2);
    // The watchlist entry is the cheapest thing to lose.
    expect(small.tracked()).not.toContain(A);
  });

  it('never sheds a held position', () => {
    const small = new SubscriptionRegistry({ maxTracked: 1 });
    small.setHeld([A], NOW);
    small.lease(B, 'viewing', NOW);
    small.lease(C, 'viewing', NOW);

    // Dropping a held token would freeze a real position's PnL, which is worse
    // than any polling cost.
    expect(small.tracked()).toContain(A);
  });
});
