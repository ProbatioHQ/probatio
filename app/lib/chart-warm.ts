import 'server-only';
import { priceFromReserves } from '@probatio/candles';
import { PoolReader, RpcClient } from '@probatio/pools';
import { backfillInFlight } from './chart-backfill';
import { db } from './db';
import { hasDedicatedRpc, rpcEndpoint } from './env';
import { topMints } from './explore';
import { background } from './background-write';
import { splicePumpfunHistory } from './pumpfun-history';

/**
 * History for charts nobody has opened yet.
 *
 * Everything else that writes a candle is driven by attention: the curve watcher
 * follows what the feed is showing, and the backfill runs when somebody opens a
 * token page. So the table only ever holds what has already been looked at, and
 * the first person to open anything else waits through "reading history" while
 * eight requests go out to pump.fun.
 *
 * That was the right shape on a 454MB volume, where the pruner was throwing away
 * charts to keep the disk alive. The volume is 4.69GB now and the resident set
 * was using under a tenth of it, because raising the retention caps only stops
 * history being deleted. Nothing goes and fetches history that was never there.
 * This is the half that fetches it, so the space bought is space used.
 *
 * The largest few hundred tokens by market cap, kept current in the background,
 * which is both the set most likely to be opened and the set whose charts have
 * the most history to hold.
 */

/**
 * Only the fetched half, never the walk.
 *
 * `backfillChart` does two things: it fetches pump.fun's candles, which is eight
 * cheap HTTP calls, and it walks the token's trades off chain, which is pages of
 * signatures and a read per trade. The fetch is what fills a chart and what fills
 * a disk; the walk is a refinement that costs hundreds of times more.
 *
 * Warming runs the fetch alone, and deliberately does not go through
 * `backfillChart` to do it. That function records a completed backfill at the
 * end of every pass, and reads that record as proof the walk has happened. A
 * warm pass writing one would mark hundreds of tokens as walked when none of
 * them had been, and the walk would then never run for any of them, leaving the
 * chart permanently missing the on-chain detail it exists to add. Nothing
 * here writes to `candle_backfills`, so a warmed token that somebody later opens
 * still gets its walk, and gets it faster for already having the history.
 */

/**
 * How many tokens are kept warm.
 *
 * Deliberately under the pruner's `PROBATIO_CANDLE_MINTS` budget of 1,200, not
 * equal to it. Retention evicts by which token has the newest candle, and a
 * warmed token is always newer than one a person opened an hour ago, so warming
 * up to the budget would let this job evict the charts of the tokens actually
 * being traded. 800 warmed leaves 400 slots for whatever the site is doing,
 * and a held token is never evicted at all.
 *
 * At the depths retention keeps, a fully warmed token is about 2MB, so this is
 * roughly 1.6GB of the volume with the rest left for the database proper, the
 * WAL and the second copy compaction makes.
 */
/*
 * Off without a dedicated endpoint.
 *
 * Warming is a luxury and it is not free: every token costs a pool resolve, and
 * a public Solana node hands out 429s to anything that asks steadily. Trading
 * needs that same endpoint to quote a fill, and a fill that cannot be quoted is
 * refused rather than guessed. So on a public node this stays off entirely
 * rather than spending the rate limit on charts nobody has asked for. Measured:
 * against api.mainnet-beta.solana.com the first resolve came back 429.
 *
 * Still an env var, so a node with an endpoint this does not recognise can turn
 * it on deliberately.
 */
const DEDICATED = hasDedicatedRpc();
const BUDGET = Number(process.env['PROBATIO_WARM_MINTS'] ?? (DEDICATED ? '800' : '0'));

/**
 * One token at a time, with a gap.
 *
 * Warming a token is eight requests to pump.fun and one pool resolve, and there
 * is nobody waiting for any of it. Twenty seconds apart puts the whole budget
 * through in about four and a half hours and keeps this job at well under one
 * request a second against a service the visible features also depend on.
 */
const TICK_MS = Number(process.env['PROBATIO_WARM_INTERVAL_MS'] ?? '20000');
/** A token warmed this recently is left alone; the cycle is shorter than this. */
const REWARM_MS = 6 * 60 * 60 * 1_000;
/** Long enough that a stuck fetch cannot wedge the loop for ever. */
const WARM_TIMEOUT_MS = 90_000;

interface WarmState {
  timer: NodeJS.Timeout | null;
  busy: boolean;
  /** Tokens warmed since boot, and candles written, for the health endpoint. */
  warmed: number;
  candles: number;
  failures: number;
  lastMint: string | null;
  lastAt: number | null;
  /** When each mint was last attempted. */
  warmedAt: Map<string, number>;
}

/*
 * Held on the global, for the reason written out in lib/health.ts: this module
 * is reached from instrumentation and from a route, and a per-bundle copy would
 * start a second warmer that neither side could see.
 *
 * `warmedAt` belongs here rather than at module scope for the same reason, and
 * it is the half that is easy to get wrong: a module-local map leaves the health
 * endpoint reading its own empty copy, so a warmer working through eight hundred
 * tokens reports nothing resident. The number then says "broken" while the job
 * is fine, which is worse than not reporting it at all.
 */
const STATE_KEY = Symbol.for('probatio.chart-warm');

function state(): WarmState {
  const global = globalThis as typeof globalThis & Record<symbol, unknown>;
  global[STATE_KEY] ??= {
    timer: null,
    busy: false,
    warmed: 0,
    candles: 0,
    failures: 0,
    lastMint: null,
    lastAt: null,
    warmedAt: new Map<string, number>(),
  } satisfies WarmState;
  return global[STATE_KEY] as WarmState;
}

/** What the health endpoint reports. */
export function warmStats(): {
  running: boolean;
  budget: number;
  warmed: number;
  candles: number;
  failures: number;
  resident: number;
  lastMint: string | null;
  lastAt: number | null;
} {
  const current = state();
  return {
    running: current.timer !== null,
    budget: BUDGET,
    warmed: current.warmed,
    candles: current.candles,
    failures: current.failures,
    resident: current.warmedAt.size,
    lastMint: current.lastMint,
    lastAt: current.lastAt,
  };
}

/**
 * The next token owed a warm, or null when every one of them is current.
 *
 * Walks the ranked list in order, so the largest tokens are warmed first on a
 * cold start and the cycle stays in market-cap order after that. Separated from
 * the fetching so the choice can be tested: everything that can go quietly
 * wrong in this job is a choice about which mint comes next, and none of it is
 * visible from the outside. A warmer that has silently settled on one mint and
 * a warmer working through the list both look like a process using no CPU.
 */
export function chooseMint(
  ranked: readonly string[],
  warmed: Map<string, number>,
  now: number,
  inFlight: (mint: string) => boolean,
  rewarmMs: number = REWARM_MS,
): string | null {
  for (const mint of ranked) {
    const at = warmed.get(mint);
    if (at !== undefined && now - at < rewarmMs) continue;
    // Somebody is opening this token right now. Their backfill writes the same
    // candles from the same source, so warming it as well is duplicated work
    // and two writers on one mint.
    if (inFlight(mint)) continue;
    return mint;
  }

  // Everything current. Forget any mint that has fallen off the list, so the
  // map tracks the ranking rather than growing for the life of the process.
  const listed = new Set(ranked);
  for (const mint of warmed.keys()) if (!listed.has(mint)) warmed.delete(mint);
  return null;
}

async function nextMint(now: number): Promise<string | null> {
  return chooseMint(await topMints(BUDGET), state().warmedAt, now, backfillInFlight);
}

/**
 * Fetch and store one token's history.
 *
 * The anchor is the live price, and it has to come from the pool rather than
 * from the listing. pump.fun reports a graduated token's bonding-curve reserves
 * frozen at the values they held when it graduated, so anchoring to those would
 * scale the whole history to a price the token had months ago and write a chart
 * that is quietly wrong. The pool resolve is two account reads and picks the
 * deepest pool, which is the same resolution the on-demand backfill uses.
 *
 * Without an anchor `splicePumpfunHistory` falls back to overlapping what is
 * already stored, and for a token being warmed for the first time there is
 * nothing to overlap, so it would write nothing at all.
 */
/*
 * One reader for the job, not one per token.
 *
 * `RpcClient` paces itself through `minIntervalMs`, and a client built inside
 * the call has nothing to pace against: each token would start fresh and the
 * spacing would only ever apply within a single resolve. Built once so the
 * limit holds across the whole cycle. Patient rather than fast: nobody is
 * waiting on this, so it yields to the reads that a person is waiting on.
 */
let reader: PoolReader | null = null;

function poolReader(): PoolReader {
  reader ??= new PoolReader(
    new RpcClient({
      endpoint: rpcEndpoint(),
      timeoutMs: 30_000,
      minIntervalMs: DEDICATED ? 50 : 400,
      maxRetries: 5,
    }),
  );
  return reader;
}

async function warmOne(mint: string): Promise<number> {
  const client = await db();
  const resolution = await poolReader().resolve(mint);
  if (!resolution?.pool) return 0;

  const anchor = Number(
    priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
  );
  if (!(anchor > 0)) return 0;

  // Thousands of candles a token, queued with the other background writers so
  // a warm does not collide with a wallet walk or with retention.
  return await background(() => splicePumpfunHistory(client, mint, anchor));
}

async function tick(): Promise<void> {
  const current = state();
  if (current.busy) return;
  current.busy = true;

  try {
    const mint = await nextMint(Date.now());
    if (mint === null) return;

    // Marked before the attempt, not after. A token whose history cannot be
    // fetched, whether delisted or never on pump.fun's candle service, would
    // otherwise be the answer to "what is owed a warm" for ever, and the loop
    // would spend its whole cycle retrying that one mint and never reach the
    // rest of the list.
    current.warmedAt.set(mint, Date.now());

    const added = await Promise.race([
      warmOne(mint),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('warm timed out')), WARM_TIMEOUT_MS),
      ),
    ]);

    current.warmed += 1;
    current.candles += added;
    current.lastMint = mint;
    current.lastAt = Date.now();
    if (added > 0) console.log(`[warm] ${mint} +${added} candles`);
  } catch (error) {
    state().failures += 1;
    console.error('[warm] failed', error);
  } finally {
    state().busy = false;
  }
}

export function startChartWarm(): void {
  if (BUDGET <= 0) {
    console.log('[warm] disabled');
    return;
  }
  const current = state();
  if (current.timer !== null) return;

  console.log(`[warm] keeping ${BUDGET} charts warm, one every ${TICK_MS / 1_000}s`);
  current.timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  current.timer.unref?.();
}
