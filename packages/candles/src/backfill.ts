import { extractTradeEvents, type RpcClient, type TradeEvent } from '@probatio/pools';
import type { Observation } from './candles';
import { priceFromReserves } from './price';

/**
 * Reconstructing a token's price history from chain.
 *
 * Every trade against a bonding curve emits an event carrying the reserves
 * after it, so history is not estimated — it is read. The prices this produces
 * come from the same reserves the fill engine quotes against, which is the
 * whole point: a chart and a fill cannot disagree.
 *
 * The cost is real. Each page of signatures is one call and each transaction is
 * another, so a token with thousands of trades is thousands of requests. Every
 * limit below exists to keep that bounded, and the caller is told when a
 * backfill stopped early rather than being left to assume it saw everything.
 */

export interface BackfillOptions {
  /** Stop after this many transactions. */
  readonly maxTransactions?: number;
  /** Stop once history reaches this far back, in unix seconds. */
  readonly since?: number;
  /**
   * How many transactions to request logs for at once.
   *
   * Kept low deliberately. A backfill is the single most request-hungry thing
   * this system does, and every provider rate-limits — running it wide is how
   * a free endpoint turns into a paid one.
   */
  readonly concurrency?: number;
}

export interface BackfillResult {
  readonly mint: string;
  readonly observations: Observation[];
  /** True when a limit stopped the walk before history ran out. */
  readonly truncated: boolean;
  readonly transactionsScanned: number;
  readonly eventsFound: number;
}

const DEFAULT_MAX_TRANSACTIONS = 500;
const DEFAULT_CONCURRENCY = 3;
const SIGNATURE_PAGE = 100;

export function observationFromEvent(event: TradeEvent): Observation {
  return {
    timestamp: event.timestamp,
    price: priceFromReserves(event.virtualSolReserves, event.virtualTokenReserves),
    volumeLamports: event.solAmount,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Walk a bonding curve's transaction history and turn it into observations.
 *
 * Failed transactions are skipped: a trade that reverted never moved the price,
 * and including it would draw a candle for something that did not happen.
 */
export async function backfillFromCurve(
  rpc: RpcClient,
  mint: string,
  curveAddress: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const observations: Observation[] = [];
  let before: string | undefined;
  let scanned = 0;
  let eventsFound = 0;
  let truncated = false;
  let reachedStart = false;

  while (scanned < maxTransactions && !reachedStart) {
    const page = await rpc.getSignatures(curveAddress, {
      limit: Math.min(SIGNATURE_PAGE, maxTransactions - scanned),
      ...(before ? { before } : {}),
    });

    if (page.length === 0) {
      reachedStart = true;
      break;
    }

    before = page[page.length - 1]!.signature;

    // A reverted trade never moved the price.
    const usable = page.filter((entry) => entry.err === null);

    // `since` is checked against the signature's own block time, so the walk
    // stops without fetching logs for transactions already known to be too old.
    const withinWindow = options.since
      ? usable.filter((entry) => entry.blockTime === null || entry.blockTime >= options.since!)
      : usable;

    if (options.since && withinWindow.length < usable.length) {
      reachedStart = true;
    }

    const logs = await mapWithConcurrency(withinWindow, concurrency, (entry) =>
      rpc.getTransactionLogs(entry.signature),
    );

    for (const entry of logs) {
      if (!entry || entry.err !== null) continue;
      for (const event of extractTradeEvents(entry.logMessages)) {
        if (event.mint !== mint) continue;
        eventsFound += 1;
        observations.push(observationFromEvent(event));
      }
    }

    scanned += page.length;
    if (page.length < SIGNATURE_PAGE) reachedStart = true;
  }

  if (!reachedStart && scanned >= maxTransactions) truncated = true;

  // Chain history arrives newest first. Candle building sorts anyway, but
  // returning it in chronological order means a caller reading the raw
  // observations is not quietly handed a reversed series.
  observations.sort((a, b) => a.timestamp - b.timestamp);

  return { mint, observations, truncated, transactionsScanned: scanned, eventsFound };
}
