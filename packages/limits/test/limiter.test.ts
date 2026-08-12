import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/limiter';

const RULE = { capacity: 3, refillMs: 3_000 };
const NOW = 1_700_000_000_000;

describe('limiting callers', () => {
  it('keeps callers apart', () => {
    const limiter = new Limiter({ rule: RULE });
    for (let i = 0; i < 3; i += 1) limiter.check('a', NOW);

    expect(limiter.check('a', NOW).allowed).toBe(false);
    expect(limiter.check('b', NOW).allowed).toBe(true);
  });

  it('lets a caller back in after refilling', () => {
    const limiter = new Limiter({ rule: RULE });
    for (let i = 0; i < 3; i += 1) limiter.check('a', NOW);

    expect(limiter.check('a', NOW + 1_000).allowed).toBe(true);
  });

  it('forgets a caller on request', () => {
    const limiter = new Limiter({ rule: RULE });
    for (let i = 0; i < 3; i += 1) limiter.check('a', NOW);

    limiter.forget('a');
    expect(limiter.check('a', NOW).allowed).toBe(true);
  });
});

describe('not becoming the leak it exists to prevent', () => {
  it('sweeps buckets that have fully refilled', () => {
    // A refilled bucket is indistinguishable from a new one, so keeping it
    // costs memory and buys nothing.
    const limiter = new Limiter({ rule: RULE, sweepMs: 1_000 });
    for (let i = 0; i < 100; i += 1) limiter.check(`caller-${i}`, NOW);
    expect(limiter.size).toBe(100);

    limiter.check('trigger', NOW + 10_000);
    expect(limiter.size).toBe(1);
  });

  it('does not sweep a bucket still holding a limit', () => {
    const limiter = new Limiter({ rule: RULE, sweepMs: 1_000 });
    for (let i = 0; i < 3; i += 1) limiter.check('a', NOW);

    limiter.check('b', NOW + 1_500);
    // Retained: 'a' spent all 3 at NOW, refilled ~1.5 by +1500, so this check
    // leaves ~0 remaining. If it had been wrongly swept it would be a fresh
    // capacity-3 bucket leaving 2 remaining, so `< 3` could not tell the sweep
    // bug apart from correct retention. Zero is the value that distinguishes.
    expect(limiter.check('a', NOW + 1_500).remaining).toBe(0);
  });

  it('caps how many callers it will ever track', () => {
    // Unbounded growth turns the thing meant to survive abuse into the way a
    // server is brought down by it.
    const limiter = new Limiter({ rule: RULE, maxEntries: 10, sweepMs: 1_000_000 });
    for (let i = 0; i < 500; i += 1) limiter.check(`caller-${i}`, NOW);

    expect(limiter.size).toBe(10);
  });

  it('evicts the least recently seen first', () => {
    const limiter = new Limiter({ rule: RULE, maxEntries: 3, sweepMs: 1_000_000 });
    limiter.check('old', NOW);
    limiter.check('b', NOW);
    limiter.check('c', NOW);
    // Touching 'old' makes it the most recent.
    limiter.check('old', NOW);
    limiter.check('d', NOW);

    limiter.check('old', NOW);
    expect(limiter.check('old', NOW).remaining).toBe(0);
  });
});
