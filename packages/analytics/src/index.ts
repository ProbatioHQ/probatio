/**
 * @probatio/analytics — what a trade log says about the trader.
 *
 * Pure functions over recorded fills. No clock, no network, no database: the
 * same log always produces the same numbers, which is what lets a profile be
 * recomputed by anyone holding the same trades and checked against the hash
 * committed on chain.
 *
 * Positions are rebuilt by replaying the log through `@probatio/trading`, the
 * same code that wrote the balances, rather than through a second copy of the
 * arithmetic.
 */

export { reconstruct } from './roundtrips';
export type { LoggedTrade, OpenTrip, Reconstruction, RoundTrip } from './roundtrips';

export { BPS, computeMetrics } from './metrics';
export type { Distribution, Metrics, NumberDistribution } from './metrics';

export { computeDrawdown } from './drawdown';
export type { Drawdown, EquityPoint } from './drawdown';

export { computeTimeOfDay } from './timing';
export type { Bucket, TimeOfDay } from './timing';

export { computeExcursion, summarizeExcursions } from './excursion';
export type { Excursion, ExcursionSummary, PriceWindow } from './excursion';
