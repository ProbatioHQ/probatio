/**
 * @probatio/keeper — batches trades and commits them on chain.
 *
 * The interesting part is not the committing, it is doing so across a database
 * and a chain that cannot be written together. A batch folded into the
 * accumulator twice can never be unfolded, so every operation here is arranged
 * to be reconcilable after a crash rather than merely likely to succeed.
 */

export { DEFAULT_MAX_BATCH, planBatches } from './plan';
export type { Batch } from './plan';

export { GatewayError } from './gateway';
export type { ChainGateway, CommitReceipt, OnChainRecord } from './gateway';

export { LeafMismatchError, leavesFor, loadTrades, toLeaf } from './leaves';
export type { StoredTrade } from './leaves';

export { rootFor, runOnce } from './runner';
export type { RunResult, RunnerOptions } from './runner';

export { Keeper, KeeperHalt, predictAccumulator } from './keeper';
export type { CommitRequest, CycleResult, Health } from './keeper';
