import 'server-only';
import {
  TIMEFRAMES,
  backfillFromCurve,
  buildCandles,
  type Timeframe,
} from '@probatio/candles';
import { getBackfill, recordBackfill, writeCandles } from '@probatio/db';
import { RpcClient, bondingCurveAddress } from '@probatio/pools';
import { db } from './db';
import { rpcEndpoint } from './env';

/**
 * History for a chart somebody is looking at.
 *
 * The curve watcher samples prices every few seconds, which fills a chart in
 * going forward but leaves the first visitor to a token staring at one candle.
 * This reads the token's actual trades off chain so the chart has a past.
 *
 * Only on demand, and only once. A backfill walks signature pages and pulls
 * logs for each transaction, which is the most request-hungry thing this system
 * does — running it for every token in the feed would turn a free endpoint into
 * a paid one within the hour. So it happens when a token page is opened, is
 * capped, and is recorded so it never runs twice for the same mint.
 */

/**
 * A cap, not a target.
 *
 * Enough to draw a chart with a shape, far short of a token's full history. The
 * result records that it was truncated rather than pretending otherwise.
 *
 * Raised from 120, which drew a chart thin enough to look broken next to the
 * same token on pump.fun. Configurable because the right number depends
 * entirely on what the RPC endpoint will tolerate: a public one refuses this
 * load, a paid one will not notice it.
 */
const MAX_TRANSACTIONS = Number(process.env['PROBATIO_BACKFILL_TRANSACTIONS'] ?? '400');
/** Never more than one of these at a time, whatever the traffic. */
const MAX_CONCURRENT = 2;

const running = new Set<string>();

/**
 * Mints already known to have been walked.
 *
 * The route asks for a backfill on every chart poll, which is every three
 * seconds per viewer, and the answer for a token that has one is always no. The
 * database knows that, but asking it three times a second per open chart is a
 * query per poll to learn something that cannot change back. Remembered here so
 * the question is asked once per process instead.
 *
 * Only ever records "done". A mint absent from this set falls through to the
 * database, so a fresh process is correct rather than merely fast.
 */
const settled = new Set<string>();

export function backfillInFlight(mint: string): boolean {
  return running.has(mint);
}

/**
 * Fill in a token's history, in the background.
 *
 * Returns immediately and never throws. The caller is answering a request; a
 * chart that is still filling in is not a reason to make anybody wait, and a
 * dead RPC is not a reason to fail the page.
 */
export function backfillChart(mint: string): void {
  if (settled.has(mint) || running.has(mint) || running.size >= MAX_CONCURRENT) return;
  running.add(mint);

  void (async () => {
    try {
      const client = await db();

      // Recorded, so this is once per token for the life of the database
      // rather than once per visitor.
      if (await getBackfill(client, mint)) {
        settled.add(mint);
        return;
      }

      const rpc = new RpcClient({
        endpoint: rpcEndpoint(),
        timeoutMs: 30_000,
        minIntervalMs: 110,
        maxRetries: 4,
      });

      const result = await backfillFromCurve(rpc, mint, bondingCurveAddress(mint), {
        maxTransactions: MAX_TRANSACTIONS,
        concurrency: 2,
      });

      const timestamps = result.observations.map((observation) => observation.timestamp);

      // Written even when empty. A token that genuinely has no trades yet must
      // still be marked as looked at, or every page view re-walks the chain to
      // rediscover that there is nothing there.
      await recordBackfill(
        client,
        {
          mint,
          oldestTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : null,
          newestTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : null,
          observations: result.observations.length,
          truncated: result.truncated,
        },
        Date.now(),
      );

      settled.add(mint);
      if (result.observations.length === 0) return;

      for (const timeframe of Object.keys(TIMEFRAMES) as Timeframe[]) {
        await writeCandles(client, mint, timeframe, buildCandles(result.observations, timeframe));
      }

      console.log(
        `[chart] ${mint} backfilled ${result.observations.length} observations from ` +
          `${result.transactionsScanned} transactions${result.truncated ? ' (truncated)' : ''}`,
      );
    } catch (error) {
      // Left unrecorded on failure, so the next visitor tries again rather
      // than inheriting a permanent blank.
      console.error('[chart] backfill failed for', mint, error);
    } finally {
      running.delete(mint);
    }
  })();
}
