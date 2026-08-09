import type { Observation } from '@probatio/candles';
import { priceFromReserves } from '@probatio/candles';
import type { PoolReader, Resolution } from '@probatio/pools';
import { RequestBudget, type BudgetOptions } from './budget';
import { SubscriptionRegistry } from './registry';

/**
 * Turning subscriptions into chain reads, and chain reads into observations.
 *
 * One tick reads what the registry says is most overdue, within what the budget
 * says is affordable. Nothing here runs on a timer of its own — the caller
 * drives it — so the whole thing stays testable and a stalled tick cannot pile
 * up overlapping work.
 */

export interface PollerOptions extends BudgetOptions {
  /** Mints read per RPC batch. Each batch costs one request against the budget. */
  readonly batchSize?: number;
}

export interface TickResult {
  readonly polled: string[];
  readonly failed: string[];
  readonly observations: Map<string, Observation>;
  /** Tokens the reader found to have graduated with no live pool. */
  readonly unlisted: string[];
  readonly requestsSpent: number;
  /** True when the budget, not demand, decided how much was read. */
  readonly budgetLimited: boolean;
}

const DEFAULT_BATCH_SIZE = 20;

export class PoolPoller {
  readonly #reader: PoolReader;
  readonly #registry: SubscriptionRegistry;
  readonly #budget: RequestBudget;
  readonly #batchSize: number;

  constructor(
    reader: PoolReader,
    registry: SubscriptionRegistry,
    options: PollerOptions,
    now = 0,
  ) {
    this.#reader = reader;
    this.#registry = registry;
    this.#budget = new RequestBudget(options, now);
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Do one round of work.
   *
   * Expired leases are pruned first, so a tick never spends budget on a token
   * nobody is watching any more.
   */
  async tick(now: number): Promise<TickResult> {
    this.#registry.prune(now);

    const available = this.#budget.available(now);
    const capacity = available * this.#batchSize;
    const wanted = this.#registry.selectBatch(now, capacity + 1);
    const budgetLimited = wanted.length > capacity;
    const mints = wanted.slice(0, capacity);

    if (mints.length === 0) {
      return {
        polled: [],
        failed: [],
        observations: new Map(),
        unlisted: [],
        requestsSpent: 0,
        budgetLimited: false,
      };
    }

    const batches = Math.ceil(mints.length / this.#batchSize);
    const granted = this.#budget.take(batches, now);

    const polled: string[] = [];
    const failed: string[] = [];
    const unlisted: string[] = [];
    const observations = new Map<string, Observation>();

    for (let i = 0; i < granted; i += 1) {
      const batch = mints.slice(i * this.#batchSize, (i + 1) * this.#batchSize);

      // Resolutions are independent, so one bad token must not cost the rest of
      // the batch its reading.
      const results = await Promise.allSettled(
        batch.map((mint) => this.#reader.resolve(mint)),
      );

      results.forEach((result, index) => {
        const mint = batch[index]!;

        if (result.status === 'rejected') {
          failed.push(mint);
          this.#registry.markError(mint, now);
          return;
        }

        const resolution: Resolution = result.value;
        this.#registry.markPolled(mint, now);
        polled.push(mint);

        if (!resolution.pool) {
          unlisted.push(mint);
          return;
        }

        observations.set(mint, {
          // The reading is stamped with wall-clock time rather than the slot,
          // because candles are bucketed by time and a slot is not a clock.
          timestamp: Math.floor(now / 1000),
          price: priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
          // A poll observes a price without a trade having happened, so it
          // contributes no volume. Counting it would inflate every chart.
          volumeLamports: 0n,
        });
      });
    }

    return {
      polled,
      failed,
      observations,
      unlisted,
      requestsSpent: granted,
      budgetLimited: budgetLimited || granted < batches,
    };
  }
}
