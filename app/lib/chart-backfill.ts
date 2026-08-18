import 'server-only';
import {
  STORED_TIMEFRAMES,
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
import { spliceGeckoHistory } from './gecko-history';
import { splicePumpfunHistory } from './pumpfun-history';

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
// Enough recent pool history to draw the last day or two accurately and to give
// the index splice a solid overlap to fix its scale against — not the whole life
// of a token doing thousands of swaps a day, which would be tens of thousands of
// reads to walk. The deep past comes from the index (see spliceGeckoHistory),
// which already has it from launch; the walk covers the recent end at the live
// price's own scale, and the two meet where the walk's oldest candle sits.
const POOL_MAX_TRANSACTIONS = Number(
  process.env['PROBATIO_POOL_BACKFILL_TRANSACTIONS'] ?? (DEDICATED ? '5000' : '400'),
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
const settled = new Map<string, number>();

/**
 * How long a token's history stands before it is fetched again.
 *
 * It used to stand for ever, which is wrong for half the chart. The live
 * watcher writes the timeframes it knows about, an hour and shorter, and
 * nothing writes the four-hour, twelve-hour and daily series at all except the
 * fetch that built them. So the moment a token was backfilled, every coarse
 * timeframe on it froze: a chart opened a day later showed a day-old last
 * candle and called it the present.
 *
 * Refetching is eight requests to a service that answers them in one call each,
 * so the cost of keeping every timeframe current is small and the cost of not
 * doing it is a chart that is quietly wrong.
 */
const REFRESH_MS = 8 * 60 * 1_000;

/** Record when a mint was last brought up to date, evicting by recency. */
function markSettled(mint: string, at: number): void {
  settled.delete(mint);
  settled.set(mint, at);
  while (settled.size > SETTLED_MAX) {
    const oldest = settled.keys().next().value;
    if (oldest === undefined) break;
    settled.delete(oldest);
  }
}

/** Whether this mint's history was refreshed recently enough to leave alone. */
function isFresh(mint: string, now: number): boolean {
  const at = settled.get(mint);
  return at !== undefined && now - at < REFRESH_MS;
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
  for (const timeframe of STORED_TIMEFRAMES) {
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
  if (isFresh(mint, Date.now()) || running.has(mint)) return;
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

      /*
       * Walked once; refreshed for as long as anybody is looking.
       *
       * The chain walk is the expensive half and only ever needs doing once,
       * so a token that has a record of one never walks again. The history
       * fetch is the cheap half and is what keeps every timeframe current, so
       * it runs again whenever the record has gone stale. Treating both as one
       * decision is what froze the coarse timeframes.
       */
      const record = await getBackfill(client, mint);
      const walked = record !== null;
      if (walked && Date.now() - record.completedAt < REFRESH_MS) {
        markSettled(mint, record.completedAt);
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

      // Resolve the pool once: its current reserves are the live price the index
      // history anchors to, and the walk reuses the same resolution.
      const reader = new PoolReader(rpc);
      let resolution: Awaited<ReturnType<typeof reader.resolve>> | null = null;
      try {
        resolution = await reader.resolve(mint);
      } catch (error) {
        console.error('[chart] resolve failed for', mint, error);
      }

      /*
       * Index history FIRST, anchored to the live price, so the whole chart is
       * on screen in a few seconds instead of after the minutes the walk takes.
       * Display-only: it never touches a fill or the trade record. The walk that
       * follows refines the recent end at the live scale and adds the sub-minute
       * detail the index does not carry; the two meet at the live price.
       */
      let historyAdded = 0;
      /*
       * Every token, not only the graduated ones.
       *
       * This was gated on the venue being a PumpSwap pool, which is a token
       * that has already bonded. Everything in the new lane is still on its
       * bonding curve, so the one source that carries a full history never ran
       * for the tokens this site is most about: they got the chain walk and the
       * live watcher and nothing else, and a chart opened on a fresh token
       * showed almost nothing. pump.fun serves candles for a curve exactly as
       * it does for a pool. A curve quotes against virtual reserves, which is
       * the same pair of numbers the anchor needs, so both venues price here.
       */
      if (resolution?.pool) {
        const anchor = Number(
          priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
        );
        const anchorPrice = anchor > 0 ? anchor : undefined;
        // pump.fun's own candle service first, for a chart that matches theirs at
        // every timeframe from launch. A general index is the fallback for a
        // token pump.fun cannot serve.
        try {
          historyAdded = await splicePumpfunHistory(client, mint, anchorPrice);
        } catch (error) {
          console.error('[chart] pump.fun history failed for', mint, error);
        }
        if (historyAdded === 0) {
          try {
            historyAdded = await spliceGeckoHistory(client, mint, anchorPrice);
          } catch (error) {
            console.error('[chart] index history failed for', mint, error);
          }
        }
      }

      /*
       * The chain walk, once and no more.
       *
       * This is the expensive half: pages of signatures and a read per trade.
       * What it produces does not change once it has been done, so a token that
       * already carries a record of one skips straight past it and keeps only
       * the refresh above, which is what the coarse timeframes actually need.
       */
      let curve: readonly Observation[] = [];
      let pool: PoolBackfill = { count: 0, oldest: null, newest: null };
      let truncated = false;

      if (!walked) {
        const result = await backfillFromCurve(rpc, mint, bondingCurveAddress(mint), {
          maxTransactions: MAX_TRANSACTIONS,
          concurrency: WALK_CONCURRENCY,
        });
        truncated = result.truncated;

        /*
         * The on-chain history: the trades up the bonding curve before
         * graduation, then the trades on the pool after it, on one price scale.
         * This refines what the fetched history laid down.
         */
        curve = result.observations;
        await writeObservationCandles(client, mint, curve);

        if (resolution?.venue.kind === 'pumpswap') {
          try {
            // Writes candles page by page as it walks; nothing to collect here.
            pool = await poolBackfill(rpc, reader, mint, client);
          } catch (error) {
            console.error('[chart] pool history failed for', mint, error);
          }
        }
      }

      // Recorded with the time of this pass, so the walk is not repeated and
      // the refresh knows when it last ran.
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
          truncated,
        },
        Date.now(),
      );
      markSettled(mint, Date.now());
      console.log(
        `[chart] ${mint} backfilled ${curve.length} curve + ${pool.count} pool + ${historyAdded} history observations`,
      );
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
