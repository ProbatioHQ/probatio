import 'server-only';
import {
  TIMEFRAMES,
  backfillFromCurve,
  buildCandles,
  priceFromReserves,
  type Observation,
  type Timeframe,
} from '@probatio/candles';
import { getBackfill, recordBackfill, writeCandles } from '@probatio/db';
import { PoolReader, RpcClient, bondingCurveAddress, pumpSwapReserveOffset } from '@probatio/pools';
import { collectPoolSwaps } from '@probatio/validation';
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
/**
 * The pool read is separate and smaller by default.
 *
 * Reading a pool trade is a getTransaction each, which a public endpoint rate
 * limits hard, so a large number fails the whole read to a 429 and the chart
 * gets no post-graduation history at all. A smaller cap is more likely to land
 * a dense recent window even on a throttled node, and a real endpoint should
 * raise it to cover a token's whole life.
 */
const POOL_MAX_TRANSACTIONS = Number(process.env['PROBATIO_POOL_BACKFILL_TRANSACTIONS'] ?? '200');
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
 * A graduated token's history from its pool.
 *
 * The curve backfill reads bonding-curve trades, which stop the moment a token
 * graduates. Everything after that, which for a token that pumped is most of
 * the chart, happens on a PumpSwap pool the curve never sees. Without this the
 * chart is one curve candle, then a vertical jump to the first live poll, with
 * the whole climb in between missing. This reads the pool's real swaps and
 * turns each into a price the same way the live feed does.
 *
 * The reserve offset is applied so these prices sit on the same scale as the
 * live price and the curve does not step at the join. It is read once at today's
 * value; it drifts slowly, so the oldest points are a hair off, which does not
 * show at chart scale.
 */
async function poolObservations(
  rpc: RpcClient,
  reader: PoolReader,
  mint: string,
): Promise<Observation[]> {
  const pools = await reader.findPumpSwapPools(mint);
  const pool = await reader.deepestPool(pools);
  if (!pool) return [];

  const config = await reader.globalConfig();
  const [account] = await rpc.getAccounts([pool.address]);
  const offset = account ? pumpSwapReserveOffset(account.data) : 0n;

  const swaps = await collectPoolSwaps(
    rpc,
    pool.address,
    pool.pool,
    { maxTransactions: POOL_MAX_TRANSACTIONS, concurrency: 1 },
    config?.protocolFeeRecipients ?? [],
  );

  const observations: Observation[] = [];
  for (const swap of swaps) {
    if (swap.blockTime === null || swap.tokenAfter <= 0n) continue;
    const sol = swap.solAfter + offset;
    if (sol <= 0n) continue;
    const delta =
      swap.solAfter > swap.solBefore ? swap.solAfter - swap.solBefore : swap.solBefore - swap.solAfter;
    observations.push({
      timestamp: swap.blockTime,
      price: priceFromReserves(sol, swap.tokenAfter),
      volumeLamports: delta,
    });
  }
  return observations;
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
        // Gentle and patient: a rate-limited node drops the whole pool read on
        // the first 429 it does not ride out, and a dropped read means no
        // post-graduation chart. Slower is better than nothing.
        minIntervalMs: 160,
        maxRetries: 7,
      });

      const result = await backfillFromCurve(rpc, mint, bondingCurveAddress(mint), {
        maxTransactions: MAX_TRANSACTIONS,
        concurrency: 2,
      });

      /*
       * A graduated token is charted from its pool, not its curve.
       *
       * This is what pump.fun shows and what makes the chart clean: the curve
       * trades are an early, far lower price regime, and stitching them onto the
       * pool history draws a cliff between the two rather than a market. So for a
       * graduated token the pool history replaces the curve rather than joining
       * it. Only if the pool read comes back empty, which on a throttled node it
       * can, does the curve chart stand in so there is something to see.
       */
      let observations = result.observations;
      let poolCount = 0;
      try {
        const reader = new PoolReader(rpc);
        const resolution = await reader.resolve(mint);
        if (resolution.venue.kind === 'pumpswap') {
          const fromPool = await poolObservations(rpc, reader, mint);
          poolCount = fromPool.length;
          if (fromPool.length > 0) {
            observations = [...fromPool].sort((a, b) => a.timestamp - b.timestamp);
          }
        }
      } catch (error) {
        console.error('[chart] pool history failed for', mint, error);
      }

      const timestamps = observations.map((observation) => observation.timestamp);

      // Written even when empty. A token that genuinely has no trades yet must
      // still be marked as looked at, or every page view re-walks the chain to
      // rediscover that there is nothing there.
      await recordBackfill(
        client,
        {
          mint,
          oldestTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : null,
          newestTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : null,
          observations: observations.length,
          truncated: result.truncated,
        },
        Date.now(),
      );

      settled.add(mint);
      if (observations.length === 0) return;

      for (const timeframe of Object.keys(TIMEFRAMES) as Timeframe[]) {
        await writeCandles(client, mint, timeframe, buildCandles(observations, timeframe));
      }

      console.log(
        `[chart] ${mint} backfilled ${observations.length} observations ` +
          `(${poolCount > 0 ? `${poolCount} pool` : `${result.observations.length} curve`})`,
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
