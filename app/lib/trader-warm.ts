import 'server-only';
import { recordObservedSwaps, recordTraderWalk, walkCandidates } from '@probatio/db';
import { PoolReader, RpcClient } from '@probatio/pools';
import { collectWalletSwaps } from '@probatio/validation';
import { background } from './background-write';
import { poolBackfill } from './chart-backfill';
import { db } from './db';
import { hasDedicatedRpc, rpcEndpoint } from './env';
import { topMints } from './explore';

/**
 * Filling the real-trader board, instead of waiting for it to fill itself.
 *
 * The first version recorded swaps as a side effect of drawing a chart, which
 * sounded efficient and produced an empty board. That path only runs for a
 * graduated token, only the first time it is walked, and only when somebody
 * opens its page, so a fresh instance shows "nothing scored yet" and keeps
 * showing it. A board whose entire purpose was to not be empty was empty.
 *
 * This walks pools on its own schedule, so the board fills within minutes of a
 * deploy and keeps up with what is actually trading. The passive path stays: it
 * costs nothing and catches tokens this list never reaches.
 *
 * That was still not enough, and the second correction is the one that made the
 * board work. Pools were the wrong thing to walk. Six hundred recent swaps of a
 * busy pool cover about half an hour, which turns up hundreds of wallets seen
 * once each: fifteen hundred wallets were read and five of them had bought and
 * sold the same token inside the slice. Nobody could be ranked, because a
 * wallet's two ends were almost never both on the table.
 *
 * So there are two walks. Pools discover wallets, cheaply and continuously.
 * Then the wallets that turn up across the most tokens have their own history
 * read, which is every trade they made, in order, across everything they
 * touched. Round trips are simply there. It is the more expensive read, and it
 * is spent only on wallets a pool walk has already vouched for.
 */

const DEDICATED = hasDedicatedRpc();

/**
 * How many of the biggest tokens to keep harvesting.
 *
 * Ranked by market cap, so these are the pools with real traders in them. Two
 * hundred is enough for a board of fifty wallets several times over, and small
 * enough that a full pass is measured in an hour rather than a day.
 */
const BUDGET = Number(process.env['PROBATIO_TRADER_MINTS'] ?? (DEDICATED ? '200' : '0'));

/** One pool at a time, with a gap. Nobody is waiting on this. */
const TICK_MS = Number(process.env['PROBATIO_TRADER_INTERVAL_MS'] ?? '5000');

/**
 * How deep to walk each pool.
 *
 * Shallower than a chart backfill on purpose. A chart wants a token's whole
 * history; this wants who has been trading it lately.
 *
 * Not too shallow, though, and this is the number that decides whether the
 * board has anything on it. A trip only counts once both ends of it are on the
 * table, so a slice that covers an hour of a pool catches almost nobody going
 * in and back out inside it. Deep enough to span a day of an active pool is
 * what turns wallets read into wallets scored.
 */
const MAX_TRANSACTIONS = Number(
  process.env['PROBATIO_TRADER_DEPTH'] ?? (DEDICATED ? '600' : '120'),
);

/** A pool harvested this recently is skipped; the cycle is shorter than this. */
const REHARVEST_MS = 6 * 60 * 60 * 1_000;

/**
 * How much of a wallet's own history to read.
 *
 * Signatures, not trades: most of what a trading wallet signs is a trade, but
 * approvals and transfers are in there too. Deep enough to hold several days of
 * an active wallet, which is where round trips live.
 */
const WALLET_DEPTH = Number(process.env['PROBATIO_TRADER_WALLET_DEPTH'] ?? '300');

/** How many wallets to read the history of, before falling back to pools alone. */
const WALLET_BUDGET = Number(
  process.env['PROBATIO_TRADER_WALLETS'] ?? (DEDICATED ? '4000' : '0'),
);

/** A wallet's history stands for a day before it is worth reading again. */
const REWALK_MS = 24 * 60 * 60 * 1_000;

/** Nothing older than this can be scored, so nothing older is worth reading. */
const SCORING_WINDOW_S = 30 * 24 * 60 * 60;

interface WarmState {
  timer: NodeJS.Timeout | null;
  busy: boolean;
  walked: number;
  swaps: number;
  failures: number;
  lastMint: string | null;
  /** Wallets whose own history has been read this process. */
  wallets: number;
  walletSwaps: number;
  lastWallet: string | null;
  /**
   * What the last failure actually said.
   *
   * A counter alone says something is wrong and nothing about what, and the
   * logs of a background job on a deployed box are not always reachable. Fifty
   * failed walks with no text is a morning of guessing.
   */
  lastError: string | null;
  /** Candidates fetched in one query and spent one per tick. */
  queue: string[];
  harvestedAt: Map<string, number>;
}

const STATE_KEY = Symbol.for('probatio.trader-warm');

function state(): WarmState {
  const global = globalThis as typeof globalThis & Record<symbol, unknown>;
  global[STATE_KEY] ??= {
    timer: null,
    busy: false,
    walked: 0,
    swaps: 0,
    failures: 0,
    lastMint: null,
    wallets: 0,
    walletSwaps: 0,
    lastWallet: null,
    lastError: null,
    queue: [],
    harvestedAt: new Map<string, number>(),
  } satisfies WarmState;
  return global[STATE_KEY] as WarmState;
}

export function traderWarmStats(): {
  running: boolean;
  budget: number;
  walked: number;
  swaps: number;
  failures: number;
  lastMint: string | null;
  wallets: number;
  walletSwaps: number;
  lastWallet: string | null;
  lastError: string | null;
  queued: number;
} {
  const current = state();
  return {
    running: current.timer !== null,
    budget: BUDGET,
    walked: current.walked,
    swaps: current.swaps,
    failures: current.failures,
    lastMint: current.lastMint,
    // Reported apart from the pool figures, because these are the reads that
    // decide whether anything can be ranked at all.
    wallets: current.wallets,
    walletSwaps: current.walletSwaps,
    lastWallet: current.lastWallet,
    lastError: current.lastError,
    queued: current.queue.length,
  };
}

/** The next pool owed a harvest, or null when they are all current. */
async function nextMint(now: number): Promise<string | null> {
  const mints = await topMints(BUDGET);
  const { harvestedAt } = state();
  for (const mint of mints) {
    const at = harvestedAt.get(mint);
    if (at !== undefined && now - at < REHARVEST_MS) continue;
    return mint;
  }
  // All current. Forget anything that fell off the list so the map tracks the
  // ranking rather than growing for the life of the process.
  const listed = new Set(mints);
  for (const mint of harvestedAt.keys()) if (!listed.has(mint)) harvestedAt.delete(mint);
  return null;
}

/**
 * Walk one pool and record who traded in it.
 *
 * Driven through the same `poolBackfill` the chart uses, rather than a second
 * copy of pool resolution that could drift from it. Candle writing is switched
 * off: a harvest wants the traders, and the chart already has its own reason to
 * write candles when somebody actually opens the token.
 */
async function harvest(mint: string): Promise<number> {
  const client = await db();
  const result = await poolBackfill(rpc(), new PoolReader(rpc()), mint, client, {
    maxTransactions: MAX_TRANSACTIONS,
    candles: false,
  });
  return result.recorded;
}

/*
 * One paced client for the whole job, so the rate limit holds across every walk
 * rather than each one starting fresh. Patient rather than fast: nothing here
 * is being waited on, so it yields to the reads that are.
 */
let rpcClient: RpcClient | null = null;

function rpc(): RpcClient {
  rpcClient ??= new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 30_000,
    /*
     * Paced for the paid node this runs against, because the shared client is
     * the real ceiling here, not the lane count. At sixty milliseconds the whole
     * job was capped at sixteen reads a second however many lanes were open, so
     * one wallet took half a minute and a board took hours to fill. Fifteen was
     * tried and pushed the endpoint into refusing, so it sits at thirty: about
     * thirty reads a second, twice the old rate and inside what the node will
     * serve without throwing walks away.
     */
    minIntervalMs: DEDICATED ? 45 : 400,
    /*
     * Enough retries that a refusal is a delay rather than a lost walk. The
     * client backs off between attempts, so this costs time on a busy endpoint
     * and nothing at all on a quiet one.
     */
    maxRetries: 7,
  });
  return rpcClient;
}

/**
 * Read one wallet's own history and record every trade in it.
 *
 * Written straight through as each page comes back rather than at the end, so a
 * walk that dies half way still leaves what it found.
 */
async function walkWallet(trader: string): Promise<number> {
  const client = await db();
  const now = Date.now();
  const until = Math.floor(now / 1_000) - SCORING_WINDOW_S;

  let written = 0;
  const swaps = await collectWalletSwaps(rpc(), trader, {
    maxTransactions: WALLET_DEPTH,
    concurrency: DEDICATED ? 5 : 2,
    until,
    onBatch: async (batch) => {
      written += await background(() =>
        recordObservedSwaps(
          client,
          batch.map((swap) => ({
            signature: swap.signature,
            trader: swap.trader,
            mint: swap.mint,
            isBuy: swap.isBuy,
            solAmount: swap.solAmount.toString(),
            tokenAmount: swap.tokenAmount.toString(),
            slot: swap.slot,
            blockTime: swap.blockTime,
            solAfter: swap.solAfter === null ? null : swap.solAfter.toString(),
            tokenAfter: swap.tokenAfter === null ? null : swap.tokenAfter.toString(),
          })),
          now,
        ),
      );
    },
  });

  // Recorded whatever it found, including nothing. A wallet that turns out not
  // to trade must not be read again tomorrow.
  await background(() => recordTraderWalk(client, trader, swaps.length, now));
  return written;
}

/*
 * Wallets first, several at once, and pools only occasionally.
 *
 * Only a wallet walk can put a row on the board, and one at a time filled a
 * page at the rate of about one wallet a minute, which is how a board with
 * thousands of candidates waiting still showed four rows. Several run at once
 * now, and a pool walk no longer blocks them: discovery is not what the page is
 * waiting on, since the table already holds thousands of wallets nobody has
 * read yet.
 */
/*
 * Lanes read in parallel; their writes still go one at a time.
 *
 * Eight lanes each writing a batch of a hundred swaps, alongside the house
 * accounts and retention, was more writers than SQLite has. The reads are what
 * this job spends its time on, so four lanes reading and one write queue behind
 * them is most of the speed and none of the contention.
 */
const WALLET_LANES = Number(process.env['PROBATIO_TRADER_LANES'] ?? (DEDICATED ? '4' : '1'));
const POOL_EVERY = 3;
let turn = 0;
let inflight = 0;
/** One refill at a time, or every free lane fetches the same candidates. */
let refilling: Promise<void> | null = null;

async function refill(now: number): Promise<void> {
  const current = state();
  const client = await db();
  current.queue = await walkCandidates(client, {
    since: Math.floor(now / 1_000) - SCORING_WINDOW_S,
    staleBefore: now - REWALK_MS,
    limit: 200,
  });
}

/** The next wallet owed a full read, refilling the queue when it runs dry. */
async function nextWallet(now: number): Promise<string | null> {
  const current = state();
  const queued = current.queue.shift();
  if (queued !== undefined) return queued;
  if (WALLET_BUDGET <= 0) return null;

  refilling ??= refill(now).finally(() => {
    refilling = null;
  });
  await refilling;
  return state().queue.shift() ?? null;
}

async function walletLane(trader: string): Promise<void> {
  const current = state();
  try {
    const written = await walkWallet(trader);
    current.wallets += 1;
    current.walletSwaps += written;
    current.lastWallet = trader;
    if (written > 0) console.log(`[traders] wallet ${trader} +${written} swaps`);
  } catch (error) {
    current.failures += 1;
    current.lastError = String(error).slice(0, 300);
    console.warn('[traders] wallet walk failed', error);
  }
}

async function poolLane(): Promise<void> {
  const current = state();
  if (current.busy) return;
  current.busy = true;
  try {
    const mint = await nextMint(Date.now());
    if (mint === null) return;

    // Marked before the attempt. A pool that cannot be walked would otherwise
    // be the answer to "what is next" for ever and the cycle would never reach
    // anything else.
    current.harvestedAt.set(mint, Date.now());

    const recorded = await harvest(mint);
    current.walked += 1;
    current.swaps += recorded;
    current.lastMint = mint;
    if (recorded > 0) console.log(`[traders] ${mint} +${recorded} swaps`);
  } catch (error) {
    current.failures += 1;
    current.lastError = String(error).slice(0, 300);
    console.warn('[traders] harvest failed', error);
  } finally {
    current.busy = false;
  }
}

async function tick(): Promise<void> {
  const current = state();

  turn += 1;
  // Started, not awaited. A pool walk is minutes of reads and the wallet lanes
  // below are what the page is actually waiting on.
  if (turn % POOL_EVERY === 0) void poolLane();

  while (inflight < WALLET_LANES && current.wallets + inflight < WALLET_BUDGET) {
    const trader = await nextWallet(Date.now());
    if (trader === null) break;
    inflight += 1;
    void walletLane(trader).finally(() => {
      inflight -= 1;
    });
  }
}

export function startTraderWarm(): void {
  if (BUDGET <= 0) {
    console.log('[traders] disabled');
    return;
  }
  const current = state();
  if (current.timer !== null) return;

  console.log(
    `[traders] reading ${WALLET_BUDGET} wallet histories ${WALLET_LANES} at a time, ` +
      `and discovering from ${BUDGET} pools`,
  );
  // Straight away, so a fresh deploy has a board in minutes rather than after
  // the first interval.
  void tick();
  current.timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  current.timer.unref?.();
}
