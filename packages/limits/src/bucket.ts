/**
 * Token buckets.
 *
 * A bucket refills continuously rather than resetting on a boundary. Fixed
 * windows let somebody spend a whole allowance in the last second of one window
 * and the whole of the next in the first second of the following one, which is
 * twice the intended rate at exactly the moment a burst is most likely.
 *
 * The clock is passed in. Nothing here reads `Date.now`, so every behaviour
 * below is testable without waiting for real seconds to pass.
 */

export interface BucketRule {
  /** Requests allowed in a burst. */
  readonly capacity: number;
  /** How long a fully drained bucket takes to refill, in milliseconds. */
  readonly refillMs: number;
}

export interface BucketState {
  /** Fractional on purpose: a bucket refills continuously. */
  tokens: number;
  lastRefillAt: number;
}

export interface Decision {
  readonly allowed: boolean;
  /** Whole tokens left after this request. */
  readonly remaining: number;
  /** Milliseconds until one token is available. Zero when allowed. */
  readonly retryAfterMs: number;
}

export function newBucket(rule: BucketRule, now: number): BucketState {
  return { tokens: rule.capacity, lastRefillAt: now };
}

function refill(state: BucketState, rule: BucketRule, now: number): void {
  const elapsed = now - state.lastRefillAt;
  // A clock that went backwards must not mint tokens.
  if (elapsed <= 0) {
    if (elapsed < 0) state.lastRefillAt = now;
    return;
  }

  const perMs = rule.capacity / rule.refillMs;
  state.tokens = Math.min(rule.capacity, state.tokens + elapsed * perMs);
  state.lastRefillAt = now;
}

export function take(state: BucketState, rule: BucketRule, now: number, cost = 1): Decision {
  refill(state, rule, now);

  if (state.tokens >= cost) {
    state.tokens -= cost;
    return { allowed: true, remaining: Math.floor(state.tokens), retryAfterMs: 0 };
  }

  const missing = cost - state.tokens;
  const perMs = rule.capacity / rule.refillMs;
  return {
    allowed: false,
    remaining: Math.floor(state.tokens),
    // Rounded up: telling somebody to retry a moment too early only produces
    // a second refusal.
    retryAfterMs: Math.ceil(missing / perMs),
  };
}
