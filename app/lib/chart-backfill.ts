import 'server-only';
import {
  TIMEFRAMES,
  backfillFromCurve,
  buildCandles,
  priceFromReserves,
  type Observation,
  type Timeframe,
} from '@probatio/candles';
import { getBackfill, recordBackfill, writeCandles, type Client } from '@probatio/db';
import { PoolReader, RpcClient, bondingCurveAddress, pumpSwapReserveOffset } from '@probatio/pools';
import { collectPoolSwaps, type PoolSwap } from '@probatio/validation';
import { db } from './db';
import { hasDedicatedRpc, rpcEndpoint } from './env';

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
 * How deep to walk, and how hard to push, depend entirely on the endpoint.
 *
 * Reading a trade is a getTransaction each. A public node rate-limits a burst of
 * them so hard that a deep read fails to a 429 and the chart gets no history, so
 * there the walk is shallow, single-file, and patient. A paid node serves the
 * same burst in seconds, so there it walks a token's whole life at real
 * concurrency. The endpoint is detected rather than configured, and either
 * number can still be overridden by env for a token or a node that wants
 * something else.
 */
const DEDICATED = hasDedicatedRpc();
const MAX_TRANSACTIONS = Number(
  process.env['PROBATIO_BACKFILL_TRANSACTIONS'] ?? (DEDICATED ? '4000' : '400'),
);
// Deep enough to reach the launch of even a heavily traded token, not just the
// last day or two. A token doing thousands of swaps buries a week of history
// under the recent ones, so a shallow walk drew one early candle and then a
// flat line across the gap — the whole middle of its life missing. Walked page
// by page and written as it goes, so the recent chart is there in seconds and
// the deep past fills in behind it over the next few minutes.
const POOL_MAX_TRANSACTIONS = Number(
  process.env['PROBATIO_POOL_BACKFILL_TRANSACTIONS'] ?? (DEDICATED ? '15000' : '400'),
);
/** How many trade reads run at once during a walk. */
const WALK_CONCURRENCY = DEDICATED ? 12 : 2;
/** The smallest gap between reads, and how many times a throttled one retries. */
const READ_INTERVAL_MS = DEDICATED ? 20 : 160;
const READ_RETRIES = DEDICATED ? 4 : 7;
/** Never more than this many whole backfills at once, whatever the traffic. */
const MAX_CONCURRENT = DEDICATED ? 6 : 2;

const running = new Set<string>();

/**
 * Mints owed a walk that the concurrency cap deferred.
 *
 * A token asked for while the cap is full is not walked yet, but it is not done
 * either, and the chart must be told the difference. Reported as in-flight so
 * the page keeps waiting for history rather than deciding the two live candles
 * it has are the whole of it. The next poll, once a slot has freed, starts it.
 */
const pending = new Set<string>();

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
 *
 * Bounded, because a pump.fun-scale feed charts thousands of distinct mints a
 * day and this used to keep every one of them for the life of the process, a
 * slow leak of tens of megabytes over a long uptime. It is only a cache: an
 * evicted mint costs one database round trip to re-confirm, not a re-walk.
 */
const SETTLED_MAX = 5_000;
const settled = new Set<string>();

/** Record a mint as walked, evicting the oldest once the cache is full. */
function markSettled(mint: string): void {
  // Re-adding moves it to the newest position, so eviction is by recency.
  settled.delete(mint);
  settled.add(mint);
  while (settled.size > SETTLED_MAX) {
    const oldest = settled.values().next().value;
    if (oldest === undefined) break;
    settled.delete(oldest);
  }
}

export function backfillInFlight(mint: string): boolean {
  return running.has(mint) || pending.has(mint);
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
async function writeObservationCandles(
  client: Client,
  mint: string,
  observations: readonly Observation[],
): Promise<void> {
  if (observations.length === 0) return;
  for (const timeframe of Object.keys(TIMEFRAMES) as Timeframe[]) {
    await writeCandles(client, mint, timeframe, buildCandles(observations, timeframe));
  }
}

interface PoolBackfill {
  count: number;
  oldest: number | null;
  newest: number | null;
}

/**
 * Write a graduated token's pool history to candles, page by page.
 *
 * Written as each page of swaps arrives — newest first — rather than after the
 * whole walk, so the recent chart draws in a second or two and the deeper past
 * fills in behind it. Candle writes merge, so a later page's older buckets sit
 * beside the earlier page's recent ones without either overwriting the other.
 */
async function poolBackfill(
  rpc: RpcClient,
  reader: PoolReader,
  mint: string,
  client: Client,
): Promise<PoolBackfill> {
  const pools = await reader.findPumpSwapPools(mint);
  const pool = await reader.deepestPool(pools);
  if (!pool) return { count: 0, oldest: null, newest: null };

  const config = await reader.globalConfig();
  const [account] = await rpc.getAccounts([pool.address]);
  const offset = account ? pumpSwapReserveOffset(account.data) : 0n;

  const toObservations = (swaps: readonly PoolSwap[]): Observation[] => {
    const out: Observation[] = [];
    for (const swap of swaps) {
      if (swap.blockTime === null || swap.tokenAfter <= 0n) continue;
      const sol = swap.solAfter + offset;
      if (sol <= 0n) continue;
      const delta =
        swap.solAfter > swap.solBefore ? swap.solAfter - swap.solBefore : swap.solBefore - swap.solAfter;
      out.push({
        timestamp: swap.blockTime,
        price: priceFromReserves(sol, swap.tokenAfter),
        volumeLamports: delta,
      });
    }
    return out;
  };

  let count = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  await collectPoolSwaps(
    rpc,
    pool.address,
    pool.pool,
    {
      maxTransactions: POOL_MAX_TRANSACTIONS,
      concurrency: WALK_CONCURRENCY,
      onBatch: async (pageSwaps) => {
        const observations = toObservations(pageSwaps);
        if (observations.length === 0) return;
        count += observations.length;
        for (const observation of observations) {
          if (oldest === null || observation.timestamp < oldest) oldest = observation.timestamp;
          if (newest === null || observation.timestamp > newest) newest = observation.timestamp;
        }
        await writeObservationCandles(client, mint, observations);
      },
    },
    config?.protocolFeeRecipients ?? [],
  );

  return { count, oldest, newest };
}

/**
 * Fill in a token's history, in the background.
 *
 * Returns immediately and never throws. The caller is answering a request; a
 * chart that is still filling in is not a reason to make anybody wait, and a
 * dead RPC is not a reason to fail the page.
 */
export function backfillChart(mint: string): void {
  if (settled.has(mint) || running.has(mint)) return;
  if (running.size >= MAX_CONCURRENT) {
    // Owed a walk, not done. Kept in-flight so the chart waits; a later poll
    // with a free slot picks it up.
    pending.add(mint);
    return;
  }
  pending.delete(mint);
  running.add(mint);

  void (async () => {
    try {
      const client = await db();

      // Recorded, so this is once per token for the life of the database
      // rather than once per visitor.
      if (await getBackfill(client, mint)) {
        markSettled(mint);
        return;
      }

      const rpc = new RpcClient({
        endpoint: rpcEndpoint(),
        timeoutMs: 30_000,
        // Paced to the endpoint. A public node drops the whole read on the first
        // 429 it cannot ride out, so there this is patient and single-file; a
        // paid node serves the burst at once, so there it is fast and parallel.
        minIntervalMs: READ_INTERVAL_MS,
        maxRetries: READ_RETRIES,
      });

      const result = await backfillFromCurve(rpc, mint, bondingCurveAddress(mint), {
        maxTransactions: MAX_TRANSACTIONS,
        concurrency: WALK_CONCURRENCY,
      });

      /*
       * The whole history, from launch: the trades up the bonding curve before
       * graduation, then the trades on the pool after it.
       *
       * These used to be treated as either/or — a graduated token showed only
       * its pool — which hid everything before it graduated, which for a token
       * days old is most of its life. They sit on one price scale (the pool's
       * reserve offset lines the two up), so writing both draws the real chart:
       * the climb up the curve, graduation, and the market that followed.
       */
      const curve = result.observations;
      // The curve history first: a token's life before it graduated.
      await writeObservationCandles(client, mint, curve);

      let pool: PoolBackfill = { count: 0, oldest: null, newest: null };
      try {
        const reader = new PoolReader(rpc);
        const resolution = await reader.resolve(mint);
        if (resolution.venue.kind === 'pumpswap') {
          // Writes candles page by page as it walks; nothing to collect here.
          pool = await poolBackfill(rpc, reader, mint, client);
        }
      } catch (error) {
        console.error('[chart] pool history failed for', mint, error);
      }

      // Record the combined span, so the token is not walked again.
      const times: number[] = curve.map((observation) => observation.timestamp);
      if (pool.oldest !== null) times.push(pool.oldest);
      if (pool.newest !== null) times.push(pool.newest);
      await recordBackfill(
        client,
        {
          mint,
          oldestTimestamp: times.length > 0 ? Math.min(...times) : null,
          newestTimestamp: times.length > 0 ? Math.max(...times) : null,
          observations: curve.length + pool.count,
          truncated: result.truncated,
        },
        Date.now(),
      );
      markSettled(mint);
      console.log(`[chart] ${mint} backfilled ${curve.length} curve + ${pool.count} pool observations`);
    } catch (error) {
      // Left unrecorded on failure, so the next visitor tries again rather
      // than inheriting a permanent blank.
      console.error('[chart] backfill failed for', mint, error);
    } finally {
      running.delete(mint);
      // Pull the next deferred walk in as this slot frees, rather than waiting
      // for its chart to poll again. A viewer who left while capped would
      // otherwise strand their mint in `pending` for the life of the process,
      // where it also reads as forever in-flight.
      const next = pending.values().next().value;
      if (next !== undefined) {
        pending.delete(next);
        backfillChart(next);
      }
    }
  })();
}
