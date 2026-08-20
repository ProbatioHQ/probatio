import 'server-only';
import { STORED_TIMEFRAMES, buildCandles, priceFromReserves } from '@probatio/candles';
import { heldMints, writeCandles } from '@probatio/db';
import { PoolReader, RpcClient } from '@probatio/pools';
import { background } from './background-write';
import { db } from './db';
import { hasDedicatedRpc, rpcEndpoint } from './env';

/**
 * Keeping a price on everything somebody is holding.
 *
 * A leaderboard has to mark open positions at something, and nothing on this
 * site was keeping a price for a token that is only held. The curve watcher
 * follows new launches. The price feed follows whatever a visitor has open on
 * screen. A position nobody is looking at falls between the two.
 *
 * The consequence was not subtle and took three attempts to find, because it
 * looked like a trading problem. Twenty-nine of twenty-nine open positions came
 * back unpriced, so all of them were marked at what they cost, so every row on
 * the board showed exactly the balance it started with however well or badly it
 * had traded. Sizing the trades up did nothing. Trading things that actually
 * move did nothing. The column could not move, because nothing was ever going
 * to reprice it.
 *
 * Reading the chain inside the request that draws the board is what was tried,
 * and it is the wrong shape: thirty pool resolutions of several round trips
 * each, against a four second budget, sharing an endpoint with three other
 * jobs. It never finished and never could.
 *
 * So it happens out here on its own clock, with nobody waiting on it. Samples
 * are written as candles, which is what the curve watcher already does with the
 * prices it takes, so the same read serves the board and any chart of that
 * token.
 */

/** Off without a dedicated endpoint, like every other background reader. */
const ENABLED = process.env['PROBATIO_DISABLE_MARKS'] !== '1' && hasDedicatedRpc();

/** How often to sweep. Positions are marked, not quoted; a minute is plenty. */
const TICK_MS = Number(process.env['PROBATIO_MARK_INTERVAL_MS'] ?? '60000');

/**
 * How many held tokens to price in one sweep.
 *
 * A ceiling rather than a target. The list is however many distinct tokens the
 * whole site is holding, which is small today and is not guaranteed to stay
 * that way, and this must never become the job that saturates the endpoint.
 */
const MAX_PER_SWEEP = Number(process.env['PROBATIO_MARK_BUDGET'] ?? '80');

interface MarkState {
  timer: NodeJS.Timeout | null;
  busy: boolean;
  sweeps: number;
  priced: number;
  failures: number;
  lastCount: number;
  lastError: string | null;
  /** Where the last sweep stopped, so a long list is walked rather than retried. */
  cursor: number;
}

const STATE_KEY = Symbol.for('probatio.mark-prices');

function state(): MarkState {
  const global = globalThis as typeof globalThis & Record<symbol, unknown>;
  global[STATE_KEY] ??= {
    timer: null,
    busy: false,
    sweeps: 0,
    priced: 0,
    failures: 0,
    lastCount: 0,
    lastError: null,
    cursor: 0,
  } satisfies MarkState;
  return global[STATE_KEY] as MarkState;
}

export function markStats(): {
  running: boolean;
  sweeps: number;
  priced: number;
  failures: number;
  holding: number;
  lastError: string | null;
} {
  const current = state();
  return {
    running: current.timer !== null,
    sweeps: current.sweeps,
    priced: current.priced,
    failures: current.failures,
    holding: current.lastCount,
    lastError: current.lastError,
  };
}

/*
 * Its own paced client, patient on purpose.
 *
 * Nothing is waiting on a mark. It yields to the trade path, which is the one
 * read that must never be slow, and to the wallet walker, which is the one that
 * fills the board next to this one.
 */
let rpcClient: RpcClient | null = null;

function rpc(): RpcClient {
  rpcClient ??= new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 15_000,
    minIntervalMs: 200,
    maxRetries: 5,
  });
  return rpcClient;
}

async function sweep(): Promise<void> {
  const current = state();
  const client = await db();
  const mints = await heldMints(client);
  current.lastCount = mints.length;
  if (mints.length === 0) return;

  // Walked from where the last sweep stopped, so a list longer than the budget
  // is covered over several sweeps rather than the same prefix every time.
  const start = current.cursor % mints.length;
  const take = Math.min(MAX_PER_SWEEP, mints.length);
  current.cursor = (start + take) % mints.length;

  const reader = new PoolReader(rpc());
  const now = Math.floor(Date.now() / 1_000);

  for (let i = 0; i < take; i += 1) {
    const mint = mints[(start + i) % mints.length];
    if (mint === undefined) continue;

    try {
      const resolution = await reader.resolve(mint);
      if (!resolution.pool) continue;

      const observation = {
        timestamp: now,
        price: priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
        // A price observed, not a trade. Volume stays at zero so a bucket
        // counts only what a backfill actually found, rather than however many
        // times the site happened to look.
        volumeLamports: 0n,
      };

      for (const timeframe of STORED_TIMEFRAMES) {
        const candles = buildCandles([observation], timeframe);
        await background(() =>
          writeCandles(
            client,
            mint,
            timeframe,
            // Volume and trade count zeroed: this is a price being observed,
            // not a trade happening. Counting it would inflate every token's
            // activity by however often the site happened to look.
            candles.map((candle) => ({ ...candle, volumeLamports: 0n, trades: 0 })),
          ),
        );
      }
      current.priced += 1;
    } catch (error) {
      current.failures += 1;
      current.lastError = String(error).slice(0, 200);
    }
  }

  current.sweeps += 1;
}

async function tick(): Promise<void> {
  const current = state();
  if (current.busy) return;
  current.busy = true;
  try {
    await sweep();
  } catch (error) {
    current.failures += 1;
    current.lastError = String(error).slice(0, 200);
    console.warn('[marks] sweep failed', error);
  } finally {
    state().busy = false;
  }
}

export function startMarkPrices(): void {
  if (!ENABLED) {
    console.log('[marks] disabled');
    return;
  }
  const current = state();
  if (current.timer !== null) return;

  console.log('[marks] pricing held positions every minute');
  void tick();
  current.timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  current.timer.unref?.();
}
