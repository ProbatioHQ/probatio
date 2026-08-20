import 'server-only';
import {
  curvesToRefresh,
  gradsToRefresh,
  unpricedGrads,
  progressBpsFor,
  recordCurveStates,
  writeCandles,
  type CurveWrite,
} from '@probatio/db';
import {
  STORED_TIMEFRAMES,
  buildCandles,
  priceFromReserves,
  type Observation,
  type Timeframe,
} from '@probatio/candles';
import { PoolReader, RpcClient, decodeBondingCurve } from '@probatio/pools';
import { recentlyViewed } from './watched';
import { db } from './db';
import { publishCurves } from './launch-stream';
import { rpcEndpoint } from './env';

/**
 * Keeping the three lanes true.
 *
 * Which lane a token belongs in — new, about to bond, bonded — is a fact about
 * its bonding curve account, and that account changes on every trade. So it is
 * polled: a fixed budget of reads per pass, always spent on whatever was read
 * longest ago, so no token is starved and the cost does not grow with the size
 * of the feed.
 *
 * Batched a hundred at a time, which is what `getMultipleAccounts` takes. A
 * hundred tokens is one RPC call rather than a hundred, and that difference is
 * what makes polling affordable at all.
 *
 * Best effort throughout. A feed that took the server down with it would trade
 * a stale lane for no site.
 */

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** The RPC cap on one `getMultipleAccounts` call. */
const BATCH = 100;
/** Accounts read per pass. Two calls, so a pass is cheap enough to run often. */
const PER_PASS = 200;
const INTERVAL_MS = 12_000;
/**
 * How far back to keep watching.
 *
 * A token that launched a week ago and never moved is not going to bond, and
 * spending reads on it takes them from the ones that might. Anything older
 * keeps whatever state it last had.
 */
const WATCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;

async function pass(rpc: RpcClient): Promise<void> {
  const client = await db();
  const now = Date.now();

  const wanted = await curvesToRefresh(
    client,
    PER_PASS,
    Math.floor((now - WATCH_WINDOW_MS) / 1_000),
  );
  if (wanted.length === 0) return;

  const states: CurveWrite[] = [];
  // One price observation per curve read. The account carries the virtual
  // reserves every price in this system derives from, so a chart costs nothing
  // beyond the read already being made for the lanes.
  const observations = new Map<string, Observation>();

  for (let offset = 0; offset < wanted.length; offset += BATCH) {
    const slice = wanted.slice(offset, offset + BATCH);
    let accounts: Awaited<ReturnType<RpcClient['getAccounts']>>;
    try {
      accounts = await rpc.getAccounts(slice.map((entry) => entry.bondingCurve));
    } catch {
      // An unreachable node is a reason to try again next pass, not to lose
      // the states already decoded in this one.
      break;
    }

    for (const [index, account] of accounts.entries()) {
      const entry = slice[index];
      if (!entry || !account) continue;
      try {
        const curve = decodeBondingCurve(account.data);
        states.push({
          mint: entry.mint,
          realSolReserves: curve.realSolReserves,
          realTokenReserves: curve.realTokenReserves,
          virtualSolReserves: curve.virtualSolReserves,
          virtualTokenReserves: curve.virtualTokenReserves,
          complete: curve.complete,
        });

        // A graduated curve zeroes its reserves, so there is no price left to
        // read — and pricing against a zero token reserve throws.
        if (!curve.complete && curve.virtualTokenReserves > 0n) {
          observations.set(entry.mint, {
            timestamp: Math.floor(now / 1_000),
            price: priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves),
            // Zero, and deliberately. This is a price we observed, not a trade
            // we saw. Counting a poll as a trade would inflate every volume
            // figure on the site with activity that never happened.
            volumeLamports: 0n,
          });
        }
      } catch {
        // A curve that will not decode is one token missing from a lane, not
        // a reason to drop the other ninety-nine in the batch.
      }
    }
  }

  if (states.length === 0) return;

  await recordCurveStates(client, states, now);
  await recordPrices(observations);
  // Pushed to open tabs so a token crossing into another lane moves there
  // without anybody reloading — which is the entire point of the lanes.
  publishCurves(
    states.map((state) => ({
      ...state,
      progressBps: progressBpsFor(state.realTokenReserves, state.complete),
      updatedAt: now,
    })),
  );
}

/**
 * Turn observed prices into candles.
 *
 * This is what makes a chart appear at all. Nothing else in the running system
 * writes candles — the backfill script is something a person runs — so without
 * this every token on the site showed an empty chart saying it had never
 * traded, which was not true of any of them.
 *
 * Written to every timeframe, because a bucket merges on write: the same
 * observation belongs to a 1-second candle and to the hour containing it, and
 * writing both now costs less than reconstructing one later.
 */
async function recordPrices(observations: Map<string, Observation>): Promise<void> {
  if (observations.size === 0) return;
  const client = await db();

  for (const [mint, observation] of observations) {
    for (const timeframe of STORED_TIMEFRAMES) {
      const candles = buildCandles([observation], timeframe);
      try {
        await writeCandles(
          client,
          mint,
          timeframe,
          // The trade count is zeroed for the same reason the volume is. A
          // merged bucket then counts only the real trades a backfill found,
          // rather than however many times we happened to look.
          candles.map((candle) => ({ ...candle, trades: 0 })),
        );
      } catch (error) {
        console.error('[curves] could not write candles for', mint, error);
      }
    }
  }
}

/**
 * Prices for tokens that have already graduated.
 *
 * A graduated curve reports zero for every reserve, so there is nothing left to
 * price against — the market moved to an AMM pool whose address derives from
 * its creator and therefore has to be searched for. That makes this several
 * calls per token instead of a hundred tokens per call, so only a few are done
 * per pass and each is left alone for minutes afterwards.
 *
 * Without this the bonded lane is a column of dashes and every graduated token
 * has an empty chart — which is exactly backwards, since those are the ones
 * that worked.
 */
const GRADS_PER_PASS = 4;
/**
 * Extra graduated tokens priced each pass because somebody has one on screen.
 *
 * On top of the rotation rather than instead of it, so watching a chart cannot
 * starve the rest of the feed of its turn.
 */
const WATCHED_PER_PASS = 3;
/**
 * Newly bonded tokens priced each pass, ahead of everything else.
 *
 * A token that just graduated has no price until its pool is read, and the feed
 * shows it as n/a until then. These jump the queue so that blank does not sit on
 * screen for the minutes the staleness rotation would take to reach it.
 */
const UNPRICED_PER_PASS = 8;
const GRAD_REFRESH_MS = 4 * 60 * 1_000;

async function gradPass(reader: PoolReader): Promise<void> {
  const client = await db();
  const now = Date.now();

  // Never-priced grads first: they are the n/a rows a fresh visitor sees.
  const unpriced = await unpricedGrads(client, UNPRICED_PER_PASS);
  const rotation = await gradsToRefresh(client, GRADS_PER_PASS, now - GRAD_REFRESH_MS);

  /*
   * Whoever is being looked at goes first, and skips the four-minute floor.
   *
   * The floor exists so a feed of thousands does not cost thousands of calls a
   * minute. It was also being applied to the one token filling somebody's
   * screen, so a chart that polls every three seconds was reading a price that
   * moved every four minutes: fast poll, slow truth, and it looked frozen
   * because it was.
   */
  const watched = recentlyViewed(now)
    .slice(0, WATCHED_PER_PASS)
    .filter((mint) => !rotation.some((entry) => entry.mint === mint))
    .map((mint) => ({ mint }));

  // Deduplicated by mint, unpriced first, so a token never gets two reads in
  // one pass and the blank rows are cleared before anything is merely refreshed.
  const seen = new Set<string>();
  const wanted = [...unpriced, ...watched, ...rotation].filter((entry) => {
    if (seen.has(entry.mint)) return false;
    seen.add(entry.mint);
    return true;
  });
  if (wanted.length === 0) return;

  const states: CurveWrite[] = [];
  const observations = new Map<string, Observation>();

  for (const entry of wanted) {
    try {
      const resolution = await reader.resolve(entry.mint);
      if (!resolution.pool || resolution.pool.tokenReserve <= 0n) continue;

      states.push({
        mint: entry.mint,
        // The curve itself really is empty; that is what graduation means.
        realSolReserves: 0n,
        realTokenReserves: 0n,
        // The reserves the token is actually priced against now.
        virtualSolReserves: resolution.pool.solReserve,
        virtualTokenReserves: resolution.pool.tokenReserve,
        complete: true,
      });

      observations.set(entry.mint, {
        timestamp: Math.floor(now / 1_000),
        price: priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
        volumeLamports: 0n,
      });
    } catch {
      // A token whose successor pool cannot be found is one row without a
      // price, not a reason to abandon the other three.
    }
  }

  if (states.length === 0) return;

  await recordCurveStates(client, states, now);
  await recordPrices(observations);
  publishCurves(
    states.map((state) => ({
      ...state,
      progressBps: 10_000,
      updatedAt: now,
    })),
  );
}

export function startCurveWatch(): void {
  if (started) return;
  started = true;

  const rpc = new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 20_000,
    minIntervalMs: 120,
    priority: 'background',
  });
  const reader = new PoolReader(rpc);

  // Each pass reads through one rate-limited RPC, so on a slow node a pass can
  // outlast the 12s interval. Without these guards the next tick starts a second
  // copy that shares the same throttled client, so both run slower, and the
  // pile-up compounds every tick until the node recovers. A pass that is still
  // running simply skips its turn, the same way the drift watcher and the feed
  // flush protect themselves.
  let passRunning = false;
  let gradRunning = false;

  const run = (): void => {
    if (!passRunning) {
      passRunning = true;
      void pass(rpc)
        .catch((error) => console.error('[curves] pass failed', error))
        .finally(() => {
          passRunning = false;
        });
    }
    if (!gradRunning) {
      gradRunning = true;
      void gradPass(reader)
        .catch((error) => console.error('[curves] graduated pass failed', error))
        .finally(() => {
          gradRunning = false;
        });
    }
  };

  run();
  timer = setInterval(run, INTERVAL_MS);
  // Never the reason the process stays alive.
  timer.unref?.();
}

export function stopCurveWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
