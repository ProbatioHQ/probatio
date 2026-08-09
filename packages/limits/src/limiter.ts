import { newBucket, take, type BucketRule, type BucketState, type Decision } from './bucket';

/**
 * A limiter with a bounded memory.
 *
 * The bound matters more than it looks. A map keyed by caller grows with every
 * new caller and never shrinks, which turns a rate limiter — the thing meant to
 * survive abuse — into the way a server is brought down by it.
 *
 * Two defences. Idle buckets are pruned on a schedule, and if the map still
 * reaches its cap the oldest entries go first. Evicting a bucket refunds its
 * holder, which is the safe direction: the alternative is evicting an attacker
 * mid-limit and handing them a fresh allowance is bad, but evicting a real user
 * and refusing them is worse, and the cap is set far above plausible traffic.
 */

export interface LimiterOptions {
  readonly rule: BucketRule;
  /** Maximum tracked callers. */
  readonly maxEntries?: number;
  /** How often to sweep idle buckets, in milliseconds. */
  readonly sweepMs?: number;
}

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_SWEEP_MS = 60_000;

export class Limiter {
  readonly #rule: BucketRule;
  readonly #maxEntries: number;
  readonly #sweepMs: number;
  readonly #buckets = new Map<string, BucketState>();
  #lastSweepAt = 0;

  constructor(options: LimiterOptions) {
    this.#rule = options.rule;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;
  }

  get size(): number {
    return this.#buckets.size;
  }

  check(key: string, now: number, cost = 1): Decision {
    this.#maybeSweep(now);

    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = newBucket(this.#rule, now);
      this.#buckets.set(key, bucket);
    } else {
      // Re-inserting keeps insertion order meaningful, so eviction drops the
      // least recently seen rather than the first ever seen.
      this.#buckets.delete(key);
      this.#buckets.set(key, bucket);
    }

    const decision = take(bucket, this.#rule, now, cost);
    this.#enforceCap();
    return decision;
  }

  /** Drops a caller's bucket. Their next request starts full. */
  forget(key: string): void {
    this.#buckets.delete(key);
  }

  clear(): void {
    this.#buckets.clear();
    this.#lastSweepAt = 0;
  }

  #maybeSweep(now: number): void {
    if (now - this.#lastSweepAt < this.#sweepMs) return;
    this.#lastSweepAt = now;

    // A bucket that has had time to refill completely is indistinguishable from
    // a new one, so keeping it costs memory and buys nothing.
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.lastRefillAt >= this.#rule.refillMs) this.#buckets.delete(key);
    }
  }

  #enforceCap(): void {
    while (this.#buckets.size > this.#maxEntries) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done) return;
      this.#buckets.delete(oldest.value);
    }
  }
}
