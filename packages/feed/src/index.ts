/**
 * @probatio/feed — demand-driven polling.
 *
 * Nothing is read from chain unless somebody is looking at it or holding it,
 * and the total read rate is capped regardless of how many people show up.
 * Those two rules are what keep this project's running cost in tens of dollars
 * rather than hundreds.
 */

export {
  DEFAULT_LEASE_MS,
  MAX_BACKOFF_MS,
  REASON_INTERVAL_MS,
  SubscriptionRegistry,
} from './registry';
export type { Reason, RegistryOptions } from './registry';

export { RequestBudget } from './budget';
export type { BudgetOptions } from './budget';

export { PoolPoller } from './poller';
export type { PollerOptions, TickResult } from './poller';
