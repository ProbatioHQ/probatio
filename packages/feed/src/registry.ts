/**
 * Which tokens are worth spending an RPC call on, right now.
 *
 * This is the cost control for the whole system. Indexing every token on Solana
 * is the several-hundred-a-month trap; reading only what somebody is currently
 * looking at or holding keeps the bill at tens. Everything here is pure and
 * takes `now` as an argument, so the scheduling is deterministic and testable
 * without a clock or a network.
 *
 * Subscriptions are leases, not reference counts. A refcount leaks the moment a
 * browser tab closes without telling us, and a leaked refcount means paying to
 * poll a token nobody is watching, forever. A lease expires on its own unless
 * renewed, so the failure mode is a token going cold slightly early rather than
 * a bill that only grows.
 */

/** Why a token is being watched. Determines how fresh its price has to be. */
export type Reason = 'holding' | 'viewing' | 'watching';

/**
 * How often each reason wants a fresh reading.
 *
 * An open position drives a live PnL figure, so it gets the tightest interval.
 * A token merely on a watchlist can be seconds stale without anyone noticing.
 */
export const REASON_INTERVAL_MS: Readonly<Record<Reason, number>> = Object.freeze({
  holding: 1_000,
  viewing: 2_000,
  watching: 15_000,
});

/** Default lease length. A client renews while it still cares. */
export const DEFAULT_LEASE_MS = 30_000;

/** Longest an error backoff will stretch a poll interval. */
export const MAX_BACKOFF_MS = 60_000;

export interface RegistryOptions {
  /**
   * Hard ceiling on tracked tokens.
   *
   * Reached only under abuse — someone opening thousands of tokens to make us
   * pay for it. Lowest-priority leases are dropped first.
   */
  readonly maxTracked?: number;
  readonly leaseMs?: number;
}

interface Lease {
  readonly reason: Reason;
  expiresAt: number;
}

interface Entry {
  readonly mint: string;
  leases: Lease[];
  /** Server-known open position. Not a lease: it cannot be forgotten by a client. */
  held: boolean;
  lastPolledAt: number;
  consecutiveErrors: number;
}

const REASON_RANK: Readonly<Record<Reason, number>> = Object.freeze({
  holding: 0,
  viewing: 1,
  watching: 2,
});

const DEFAULT_MAX_TRACKED = 2_000;

export class SubscriptionRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #maxTracked: number;
  readonly #leaseMs: number;

  constructor(options: RegistryOptions = {}) {
    this.#maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Every mint currently tracked, in no particular order. */
  tracked(): string[] {
    return [...this.#entries.keys()];
  }

  #ensure(mint: string): Entry {
    let entry = this.#entries.get(mint);
    if (!entry) {
      entry = { mint, leases: [], held: false, lastPolledAt: 0, consecutiveErrors: 0 };
      this.#entries.set(mint, entry);
    }
    return entry;
  }

  /**
   * Take or renew a lease.
   *
   * Renewing is the same call as taking, so a client heartbeat is one code path
   * rather than two.
   */
  lease(mint: string, reason: Reason, now: number, ttlMs = this.#leaseMs): void {
    const entry = this.#ensure(mint);
    const existing = entry.leases.find((lease) => lease.reason === reason);

    if (existing) {
      existing.expiresAt = now + ttlMs;
    } else {
      entry.leases.push({ reason, expiresAt: now + ttlMs });
    }

    this.#evictIfOverCapacity(now);
  }

  /** Drop a lease early. Optional — leases expire on their own. */
  release(mint: string, reason: Reason): void {
    const entry = this.#entries.get(mint);
    if (!entry) return;

    entry.leases = entry.leases.filter((lease) => lease.reason !== reason);
    if (entry.leases.length === 0 && !entry.held) this.#entries.delete(mint);
  }

  /**
   * Replace the set of mints with open positions.
   *
   * Held tokens are not leases. The server knows what a user is holding, so it
   * cannot be forgotten by a client that stopped talking, and a position must
   * never go stale because a browser tab crashed.
   */
  setHeld(mints: readonly string[], now: number): void {
    const held = new Set(mints);

    for (const entry of this.#entries.values()) {
      entry.held = held.has(entry.mint);
    }
    for (const mint of held) {
      this.#ensure(mint).held = true;
    }

    for (const [mint, entry] of [...this.#entries]) {
      if (!entry.held && entry.leases.length === 0) this.#entries.delete(mint);
    }

    this.#evictIfOverCapacity(now);
  }

  /** Remove expired leases, and any entry left with no reason to exist. */
  prune(now: number): string[] {
    const dropped: string[] = [];

    for (const [mint, entry] of [...this.#entries]) {
      entry.leases = entry.leases.filter((lease) => lease.expiresAt > now);
      if (entry.leases.length === 0 && !entry.held) {
        this.#entries.delete(mint);
        dropped.push(mint);
      }
    }

    return dropped;
  }

  /** The tightest interval any live reason for this mint asks for. */
  intervalFor(mint: string, now: number): number {
    const entry = this.#entries.get(mint);
    if (!entry) return Number.POSITIVE_INFINITY;

    let interval = entry.held ? REASON_INTERVAL_MS.holding : Number.POSITIVE_INFINITY;
    for (const lease of entry.leases) {
      if (lease.expiresAt <= now) continue;
      interval = Math.min(interval, REASON_INTERVAL_MS[lease.reason]);
    }

    if (interval === Number.POSITIVE_INFINITY) return interval;

    // Back off a token that keeps failing rather than spending the same budget
    // on it every tick. Doubling, capped.
    if (entry.consecutiveErrors > 0) {
      const backoff = interval * 2 ** Math.min(entry.consecutiveErrors, 8);
      return Math.min(backoff, MAX_BACKOFF_MS);
    }

    return interval;
  }

  /**
   * Choose what to read next, most overdue first.
   *
   * `limit` is the budget — the caller decides how many reads it is willing to
   * pay for this tick, and this picks the ones where that money buys the most.
   * A token that is not yet due is never returned, so a quiet system makes no
   * requests at all.
   */
  selectBatch(now: number, limit: number): string[] {
    if (limit <= 0) return [];

    const due: { mint: string; overdueBy: number; rank: number }[] = [];

    for (const entry of this.#entries.values()) {
      const interval = this.intervalFor(entry.mint, now);
      if (!Number.isFinite(interval)) continue;

      const overdueBy = now - entry.lastPolledAt - interval;
      if (overdueBy < 0) continue;

      due.push({ mint: entry.mint, overdueBy, rank: this.#rankOf(entry, now) });
    }

    due.sort((a, b) =>
      a.rank === b.rank
        ? b.overdueBy - a.overdueBy
        : a.rank - b.rank,
    );

    return due.slice(0, limit).map((item) => item.mint);
  }

  markPolled(mint: string, now: number): void {
    const entry = this.#entries.get(mint);
    if (!entry) return;
    entry.lastPolledAt = now;
    entry.consecutiveErrors = 0;
  }

  markError(mint: string, now: number): void {
    const entry = this.#entries.get(mint);
    if (!entry) return;
    entry.lastPolledAt = now;
    entry.consecutiveErrors += 1;
  }

  #rankOf(entry: Entry, now: number): number {
    let rank = entry.held ? REASON_RANK.holding : Number.POSITIVE_INFINITY;
    for (const lease of entry.leases) {
      if (lease.expiresAt <= now) continue;
      rank = Math.min(rank, REASON_RANK[lease.reason]);
    }
    return rank;
  }

  /**
   * Shed the least important tokens when over capacity.
   *
   * Held tokens are never shed — dropping one would freeze a real position's
   * PnL, which is worse than any amount of polling cost.
   */
  #evictIfOverCapacity(now: number): void {
    if (this.#entries.size <= this.#maxTracked) return;

    const candidates = [...this.#entries.values()]
      .filter((entry) => !entry.held)
      .sort((a, b) => this.#rankOf(b, now) - this.#rankOf(a, now));

    let excess = this.#entries.size - this.#maxTracked;
    for (const entry of candidates) {
      if (excess <= 0) break;
      this.#entries.delete(entry.mint);
      excess -= 1;
    }
  }
}
