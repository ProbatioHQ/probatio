import type { PendingTrade } from '@probatio/db';

/**
 * Grouping uncommitted trades into batches.
 *
 * Pure, so the batching rules can be reasoned about without a database or a
 * chain in the way.
 *
 * A batch never spans two traders or two seasons, because a record is per
 * trader per season — mixing them would produce a root that belongs to nobody.
 * Within that, trades are batched in id order and split at a size limit.
 */

export interface Batch {
  readonly seasonId: number;
  readonly userPubkey: string;
  readonly tradeIds: readonly number[];
  readonly fromTradeId: number;
  readonly toTradeId: number;
  /**
   * The engine version this batch was produced under.
   *
   * A batch never mixes versions. The version is folded into the chain, so a
   * batch spanning an engine change could not be checked against either set of
   * rules — it is split instead.
   */
  readonly engineVersion: number;
}

export const DEFAULT_MAX_BATCH = 256;

export function planBatches(
  trades: readonly PendingTrade[],
  maxBatch = DEFAULT_MAX_BATCH,
): Batch[] {
  if (maxBatch < 1) throw new Error('a batch must hold at least one trade');

  const ordered = [...trades].sort((a, b) =>
    a.seasonId !== b.seasonId
      ? a.seasonId - b.seasonId
      : a.userPubkey !== b.userPubkey
        ? a.userPubkey.localeCompare(b.userPubkey)
        : a.id - b.id,
  );

  const batches: Batch[] = [];
  let current: PendingTrade[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0]!;
    batches.push({
      seasonId: first.seasonId,
      userPubkey: first.userPubkey,
      tradeIds: current.map((trade) => trade.id),
      fromTradeId: first.id,
      toTradeId: current[current.length - 1]!.id,
      engineVersion: first.engineVersion,
    });
    current = [];
  };

  for (const trade of ordered) {
    const head = current[0];
    const breaks =
      head !== undefined &&
      (head.seasonId !== trade.seasonId ||
        head.userPubkey !== trade.userPubkey ||
        head.engineVersion !== trade.engineVersion ||
        current.length >= maxBatch);

    if (breaks) flush();
    current.push(trade);
  }

  flush();
  return batches;
}
