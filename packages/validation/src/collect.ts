import { bondingCurveAddress, extractTradeEvents, type RpcClient } from '@probatio/pools';
import type { OrderedEvent } from './replay';

/**
 * Gathering a token's trade history in true execution order.
 *
 * Ordering is the part that is easy to get wrong. Several trades routinely
 * land in the same second, so sorting by timestamp breaks ties arbitrarily and
 * makes the wrong event the predecessor — which shows up downstream as large
 * errors that look like the engine is broken when it is not. Slot, then
 * position within the transaction, is the real sequence.
 */

export interface CollectOptions {
  /** How many transactions to walk. */
  readonly maxTransactions?: number;
  /** Concurrent log fetches. Kept low; every provider rate-limits. */
  readonly concurrency?: number;
  /** Called after each page, so a long run can report progress. */
  readonly onProgress?: (scanned: number, events: number) => void;
}

const SIGNATURE_PAGE = 100;
const DEFAULT_MAX_TRANSACTIONS = 300;
const DEFAULT_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!);
      }
    }),
  );

  return results;
}

export async function collectEvents(
  rpc: RpcClient,
  mint: string,
  options: CollectOptions = {},
): Promise<OrderedEvent[]> {
  const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const curveAddress = bondingCurveAddress(mint);

  const collected: OrderedEvent[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (scanned < maxTransactions) {
    const page = await rpc.getSignatures(curveAddress, {
      limit: Math.min(SIGNATURE_PAGE, maxTransactions - scanned),
      ...(before ? { before } : {}),
    });
    if (page.length === 0) break;

    before = page[page.length - 1]!.signature;
    scanned += page.length;

    // A reverted transaction never moved the curve.
    const usable = page.filter((entry) => entry.err === null);

    const logs = await mapWithConcurrency(usable, concurrency, (entry) =>
      rpc.getTransactionLogs(entry.signature),
    );

    for (const entry of logs) {
      if (!entry || entry.err !== null) continue;
      extractTradeEvents(entry.logMessages).forEach((event, indexInTx) => {
        if (event.mint !== mint) return;
        collected.push({ event, slot: entry.slot, indexInTx });
      });
    }

    options.onProgress?.(scanned, collected.length);
    if (page.length < SIGNATURE_PAGE) break;
  }

  return collected.sort((a, b) =>
    a.slot === b.slot ? a.indexInTx - b.indexInTx : a.slot - b.slot,
  );
}
