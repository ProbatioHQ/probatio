import type { Client } from '@libsql/client';
import { uncommittedTrades } from '@probatio/db';
import { buildTree, hashLeaf, toHex } from '@probatio/commit';
import { Keeper, KeeperHalt } from './keeper';
import { leavesFor, loadTrades, LeafMismatchError } from './leaves';
import { planBatches, type Batch } from './plan';

/**
 * One pass of the keeper's work.
 *
 * Reconcile anything left unresolved by a previous run, then batch whatever
 * trades are not yet committed and commit them. Reconciliation always comes
 * first: committing on top of an unresolved intent would mean guessing whether
 * an earlier batch landed, and either guess corrupts the chain permanently.
 *
 * Driven by a caller rather than a timer of its own, so a slow pass cannot
 * overlap the next one and a test can step it deterministically.
 */

export interface RunnerOptions {
  readonly maxBatchSize?: number;
  /** Trades to consider in one pass. */
  readonly maxTrades?: number;
  /** Maps a season id to the ordinal the chain knows it by. */
  readonly seasonOrdinalFor: (seasonId: number) => number;
}

export interface RunResult {
  readonly reconciled: number;
  readonly discarded: number;
  readonly batches: number;
  readonly committed: number;
  readonly tradesCommitted: number;
  readonly failed: number;
  readonly halted: string | null;
  readonly errors: readonly string[];
}

export async function runOnce(
  db: Client,
  keeper: Keeper,
  options: RunnerOptions,
): Promise<RunResult> {
  const errors: string[] = [];

  const settled = await keeper.reconcile(options.seasonOrdinalFor);
  if (settled.halt) {
    return {
      reconciled: settled.reconciled,
      discarded: settled.discarded,
      batches: 0,
      committed: 0,
      tradesCommitted: 0,
      failed: 0,
      halted: settled.halt,
      errors,
    };
  }

  const pending = await uncommittedTrades(db, options.maxTrades ?? 5_000);
  const batches = planBatches(pending, options.maxBatchSize);

  let committed = 0;
  let tradesCommitted = 0;
  let failed = 0;

  for (const batch of batches) {
    try {
      const root = await rootFor(db, batch);
      const id = await keeper.commit({
        seasonId: batch.seasonId,
        seasonOrdinal: options.seasonOrdinalFor(batch.seasonId),
        userPubkey: batch.userPubkey,
        merkleRoot: root,
        leafCount: batch.tradeIds.length,
        fromTradeId: batch.fromTradeId,
        toTradeId: batch.toTradeId,
        engineVersion: batch.engineVersion,
      });

      if (id === null) {
        failed += 1;
        // A count with no cause is what an operator cannot act on.
        errors.push(
          `${batch.userPubkey.slice(0, 8)}… season ${batch.seasonId}: ` +
            (keeper.lastFailure ?? 'commit failed with no reason recorded'),
        );
      } else {
        committed += 1;
        tradesCommitted += batch.tradeIds.length;
      }
    } catch (error) {
      if (error instanceof KeeperHalt) {
        return {
          reconciled: settled.reconciled,
          discarded: settled.discarded,
          batches: batches.length,
          committed,
          tradesCommitted,
          failed,
          halted: error.message,
          errors,
        };
      }

      // A batch whose leaves do not rebuild is a problem with those trades,
      // not with the keeper. The rest of the pass carries on rather than
      // stalling every other trader behind one bad record.
      if (error instanceof LeafMismatchError) {
        failed += 1;
        errors.push(error.message);
        continue;
      }

      throw error;
    }
  }

  return {
    reconciled: settled.reconciled,
    discarded: settled.discarded,
    batches: batches.length,
    committed,
    tradesCommitted,
    failed,
    halted: keeper.halted,
    errors,
  };
}

/** The merkle root over a batch's trades, rebuilt and checked from storage. */
export async function rootFor(db: Client, batch: Batch): Promise<string> {
  const trades = await loadTrades(
    db,
    batch.seasonId,
    batch.userPubkey,
    batch.fromTradeId,
    batch.toTradeId,
  );

  const leaves = leavesFor(trades);
  return toHex(buildTree(leaves.map((leaf) => hashLeaf(leaf))).root);
}
