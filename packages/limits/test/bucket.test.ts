import { describe, expect, it } from 'vitest';
import { newBucket, take, type BucketRule } from '../src/bucket';

const RULE: BucketRule = { capacity: 10, refillMs: 10_000 };
const NOW = 1_700_000_000_000;

describe('spending', () => {
  it('starts full', () => {
    const bucket = newBucket(RULE, NOW);
    expect(take(bucket, RULE, NOW).remaining).toBe(9);
  });

  it('allows a full burst then refuses', () => {
    const bucket = newBucket(RULE, NOW);
    for (let i = 0; i < 10; i += 1) expect(take(bucket, RULE, NOW).allowed).toBe(true);
    expect(take(bucket, RULE, NOW).allowed).toBe(false);
  });

  it('says how long to wait', () => {
    const bucket = newBucket(RULE, NOW);
    for (let i = 0; i < 10; i += 1) take(bucket, RULE, NOW);

    // One token per second at this rule.
    expect(take(bucket, RULE, NOW).retryAfterMs).toBe(1_000);
  });

  it('lets a request through once it has waited', () => {
    const bucket = newBucket(RULE, NOW);
    for (let i = 0; i < 10; i += 1) take(bucket, RULE, NOW);

    expect(take(bucket, RULE, NOW + 999).allowed).toBe(false);
    expect(take(bucket, RULE, NOW + 1_000).allowed).toBe(true);
  });
});

describe('refilling', () => {
  it('refills continuously rather than on a boundary', () => {
    // A fixed window lets somebody spend a whole allowance at the end of one
    // and the whole of the next at the start, which is twice the rate exactly
    // when a burst is most likely.
    const bucket = newBucket(RULE, NOW);
    for (let i = 0; i < 10; i += 1) take(bucket, RULE, NOW);

    expect(take(bucket, RULE, NOW + 5_000).allowed).toBe(true);
    // Five seconds bought five tokens, one of which was just spent.
    expect(take(bucket, RULE, NOW + 5_000).remaining).toBe(3);
  });

  it('never overfills', () => {
    const bucket = newBucket(RULE, NOW);
    take(bucket, RULE, NOW);
    expect(take(bucket, RULE, NOW + 10_000_000).remaining).toBe(9);
  });

  it('does not mint tokens when the clock goes backwards', () => {
    // A clock that jumps back would otherwise be a way to refill on demand.
    const bucket = newBucket(RULE, NOW);
    for (let i = 0; i < 10; i += 1) take(bucket, RULE, NOW);

    expect(take(bucket, RULE, NOW - 60_000).allowed).toBe(false);
  });

  it('carries a fraction of a token between requests', () => {
    const bucket = newBucket(RULE, NOW);
    for (let i = 0; i < 10; i += 1) take(bucket, RULE, NOW);

    // Two halves of a token add up to one.
    expect(take(bucket, RULE, NOW + 500).allowed).toBe(false);
    expect(take(bucket, RULE, NOW + 1_000).allowed).toBe(true);
  });
});

describe('costing more than one', () => {
  it('charges what it was told to', () => {
    const bucket = newBucket(RULE, NOW);
    expect(take(bucket, RULE, NOW, 4).remaining).toBe(6);
  });

  it('refuses a cost the bucket cannot cover', () => {
    const bucket = newBucket(RULE, NOW);
    const decision = take(bucket, RULE, NOW, 11);
    expect(decision.allowed).toBe(false);
    // Refused requests spend nothing.
    expect(take(bucket, RULE, NOW).remaining).toBe(9);
  });
});
