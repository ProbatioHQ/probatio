/**
 * A hard ceiling on how much chain reading this process will do.
 *
 * The registry decides *what* is worth reading; this decides *how much* is
 * affordable. The two are separate on purpose — the ceiling has to hold no
 * matter how many users show up, because an RPC bill that scales with traffic
 * is the thing that turns a free-tier project into a paid one overnight.
 *
 * A token bucket rather than a fixed window: a burst is fine as long as the
 * long-run average stays under the limit, which matches how providers actually
 * meter.
 */

export interface BudgetOptions {
  /** Sustained request rate, in requests per second. */
  readonly requestsPerSecond: number;
  /** How much burst to allow. Defaults to one second's worth. */
  readonly burst?: number;
}

export class RequestBudget {
  readonly #ratePerMs: number;
  readonly #burst: number;
  #tokens: number;
  #lastRefill: number;

  constructor(options: BudgetOptions, now = 0) {
    if (options.requestsPerSecond <= 0) {
      throw new Error('requestsPerSecond must be positive');
    }
    this.#ratePerMs = options.requestsPerSecond / 1000;
    this.#burst = options.burst ?? Math.max(1, Math.ceil(options.requestsPerSecond));
    this.#tokens = this.#burst;
    this.#lastRefill = now;
  }

  /** Requests available right now, after accounting for elapsed time. */
  available(now: number): number {
    this.#refill(now);
    return Math.floor(this.#tokens);
  }

  /**
   * Spend up to `wanted` requests, returning how many were actually granted.
   *
   * Returns less than asked rather than throwing or queueing, so a caller
   * simply does less work this tick instead of building a backlog that arrives
   * as a burst later.
   */
  take(wanted: number, now: number): number {
    if (wanted <= 0) return 0;
    this.#refill(now);

    const granted = Math.min(wanted, Math.floor(this.#tokens));
    this.#tokens -= granted;
    return granted;
  }

  #refill(now: number): void {
    if (now <= this.#lastRefill) return;
    this.#tokens = Math.min(this.#burst, this.#tokens + (now - this.#lastRefill) * this.#ratePerMs);
    this.#lastRefill = now;
  }
}
