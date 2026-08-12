import 'server-only';
import { PoolReader, RpcClient, pumpSwapReserveOffset } from '@probatio/pools';
import {
  collectEvents,
  collectPoolSwaps,
  replay,
  replayPool,
  assessDrift,
  type ValidationReport,
} from '@probatio/validation';
import { mostTradedMints, recordDrift } from '@probatio/db';
import { ENGINE_VERSION } from '@probatio/sim';
import { db } from './db';
import { rpcEndpoint } from './env';

/**
 * Watching the simulator and the market come apart, continuously.
 *
 * Every piece of this existed and nothing ran it. `assessDrift` judges the
 * engine against real fills, `recordDrift` writes the verdict down and
 * `suspendToken` takes a farmable token off the board — all written, all
 * tested, all with no caller. This is the caller.
 *
 * It matters more than it looks. Four separate passes of manual measurement
 * found the engine mispricing graduated pools by thousands of basis points, and
 * every one of those was a person sitting down and deciding to go and check. A
 * monitor that runs on a timer would have raised the same finding the day it
 * started, without anybody thinking to look. The manual work found the bugs;
 * this is what stops the next one waiting for somebody to be curious.
 *
 * What it does not do is decide anything about a season. It records what it
 * measured and suspends a token that is farmable, which is the one action that
 * cannot wait — leaving a generous token live while somebody investigates is
 * how a season's results become worthless. Lifting a suspension is deliberate
 * and manual, because "the number looks fine again" is not evidence that
 * whatever caused it is gone.
 */

function ms(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How often to look. Long, because each cycle costs real RPC calls. */
const INTERVAL_MS = ms('PROBATIO_DRIFT_INTERVAL_MS', 30 * 60 * 1_000);
/** A short delay before the first cycle, so start-up is not the busiest moment. */
const FIRST_RUN_MS = ms('PROBATIO_DRIFT_FIRST_RUN_MS', 90 * 1_000);
/** Tokens per cycle. The budget is RPC calls, and this is the main lever. */
const TOKENS_PER_CYCLE = 4;
/** Trades within this window count toward what is worth checking. */
const RECENT_MS = 24 * 60 * 60 * 1_000;
/** Transactions to walk per token. Enough for the sample floor, no more. */
const TRANSACTIONS_PER_TOKEN = 120;
/**
 * How hard to lean on the RPC.
 *
 * Deliberately slow. A cycle is a background trickle with half an hour before
 * the next one, so there is nothing to gain by hurrying, and the first live run
 * of this monitor took HTTP 429 from a public endpoint on every token — it
 * failed safe and reported honestly, and measured nothing at all.
 */
const RPC_INTERVAL_MS = ms('PROBATIO_DRIFT_RPC_INTERVAL_MS', 400);
/**
 * Cycles that may produce no samples before the monitor calls itself unwell.
 *
 * The failure this exists to prevent is a check that quietly stopped checking.
 * "No samples" reads like a calm answer and is not one: a monitor that cannot
 * reach the chain reports exactly the same thing forever as one watching a
 * healthy market, and the whole point is to not need somebody to notice.
 */
const BLIND_CYCLES = 3;

interface WatchState {
  running: boolean;
  timer: NodeJS.Timeout | null;
  lastRunAt: number;
  lastSummary: string;
  cycles: number;
  suspended: number;
  /** Cycles in a row that measured nothing. */
  blindCycles: number;
  /** Cycles in a row that threw before completing. */
  failures: number;
  lastSampledAt: number;
}

/** Consecutive throwing cycles before the monitor is called unhealthy. */
const MAX_FAILURES = 3;
/**
 * How stale `lastRunAt` may get before the monitor counts as wedged. A cycle
 * that throws before it can update `lastRunAt` freezes it, so a monitor that
 * fails every tick goes stale here even if the failure counter were missed.
 */
const STALE_AFTER = INTERVAL_MS * (MAX_FAILURES + 1);

/**
 * Shared across bundles, for the reason written out in lib/health.ts: this
 * module is reached from instrumentation and from route handlers, which compile
 * separately, and a per-bundle copy means two monitors both spending the RPC
 * budget while each reports the other's work as missing.
 */
const WATCH_KEY = Symbol.for('probatio.drift-watch');

function state(): WatchState {
  const store = globalThis as typeof globalThis & { [WATCH_KEY]?: WatchState };
  store[WATCH_KEY] ??= {
    running: false,
    timer: null,
    lastRunAt: 0,
    lastSummary: 'not run yet',
    cycles: 0,
    suspended: 0,
    blindCycles: 0,
    failures: 0,
    lastSampledAt: 0,
  };
  return store[WATCH_KEY];
}

/** What the monitor has seen, for the health surface. */
export function driftStatus(): {
  running: boolean;
  /** False when it cannot measure, keeps throwing, or has stopped ticking. */
  healthy: boolean;
  lastRunAt: number;
  lastSampledAt: number;
  lastSummary: string;
  cycles: number;
  suspended: number;
  failures: number;
} {
  const current = state();
  // A monitor that stopped checking weeks ago must not report healthy. It has
  // run at least once but its lastRunAt has not moved in several intervals,
  // because every cycle now throws before it can update it.
  const stale = current.lastRunAt > 0 && Date.now() - current.lastRunAt > STALE_AFTER;
  return {
    running: current.running,
    // Not yet run is not unhealthy. Repeatedly unable to see, repeatedly
    // throwing, or frozen is.
    healthy: current.blindCycles < BLIND_CYCLES && current.failures < MAX_FAILURES && !stale,
    lastRunAt: current.lastRunAt,
    lastSampledAt: current.lastSampledAt,
    lastSummary: current.lastSummary,
    cycles: current.cycles,
    suspended: current.suspended,
    failures: current.failures,
  };
}

/**
 * Measure one token against the chain.
 *
 * Returns null rather than throwing, and rather than returning an empty report:
 * a token that could not be sampled has not been found innocent, and feeding a
 * zero-sample report into the assessment would let it read as clean.
 */
async function measure(
  reader: PoolReader,
  rpc: RpcClient,
  mint: string,
): Promise<ValidationReport | null> {
  const resolution = await reader.resolve(mint);

  if (resolution.venue.kind === 'pumpfun-curve') {
    const ordered = await collectEvents(rpc, mint, {
      maxTransactions: TRANSACTIONS_PER_TOKEN,
      concurrency: 1,
    });
    if (ordered.length === 0) return null;
    return replay(mint, ordered, ENGINE_VERSION);
  }

  if (resolution.venue.kind === 'pumpswap') {
    const pools = await reader.findPumpSwapPools(mint);
    const pool = await reader.deepestPool(pools);
    if (!pool) return null;

    const config = await reader.globalConfig();
    const fees = await reader.pumpSwapFees(pool.pool);
    const [account] = await rpc.getAccounts([pool.address]);
    const offset = account ? pumpSwapReserveOffset(account.data) : 0n;

    const swaps = await collectPoolSwaps(
      rpc,
      pool.address,
      pool.pool,
      { maxTransactions: TRANSACTIONS_PER_TOKEN, concurrency: 1 },
      config?.protocolFeeRecipients ?? [],
    );
    if (swaps.length === 0) return null;

    const decimals = resolution.pool?.tokenDecimals ?? 6;
    return replayPool(mint, swaps, decimals, ENGINE_VERSION, fees, offset);
  }

  // Unlisted: no market to be wrong about.
  return null;
}

/** One pass over the tokens people are actually trading. */
export async function runDriftCycle(): Promise<void> {
  const current = state();
  const client = await db();
  const now = Date.now();

  const mints = await mostTradedMints(client, now - RECENT_MS, TOKENS_PER_CYCLE);
  if (mints.length === 0) {
    // Nothing to check is not the same as failing to check. It does not count
    // toward going blind, because there was nothing to see.
    current.lastRunAt = now;
    current.lastSummary = 'nothing traded recently';
    current.cycles += 1;
    return;
  }

  const rpc = new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 25_000,
    minIntervalMs: RPC_INTERVAL_MS,
  });
  const reader = new PoolReader(rpc);

  const reports: ValidationReport[] = [];
  for (const mint of mints) {
    try {
      const report = await measure(reader, rpc, mint);
      if (report) reports.push(report);
    } catch (error) {
      // One unreadable token must not stop the others being checked.
      console.error('[drift] could not measure', mint, error);
    }
  }

  if (reports.length === 0) {
    current.lastRunAt = Date.now();
    current.cycles += 1;
    current.blindCycles += 1;
    current.lastSummary =
      current.blindCycles >= BLIND_CYCLES
        ? `measured nothing for ${current.blindCycles} cycles, so the engine is going unchecked, ` +
          'which usually means the RPC endpoint is refusing the load'
        : `no samples from ${mints.length} token(s)`;
    return;
  }

  current.blindCycles = 0;
  current.lastSampledAt = Date.now();

  const assessment = assessDrift(reports);

  // The suspensions ride in the same write as the observations, so there is
  // never a committed "this token is farmable" without the token being off the
  // board. A token filling better here than on the chain is free money to
  // whoever notices, so it comes off now and the why is answered afterwards.
  const suspensions = assessment.suspend.map((mint) => {
    const token = assessment.tokens.find((entry) => entry.mint === mint);
    return {
      mint,
      reason:
        `the simulator filled ${token?.medianSignedBps ?? 0}bps better than the chain across ` +
        `${token?.samples ?? 0} samples`,
      severity: 'exploitable' as const,
    };
  });

  await recordDrift(
    client,
    assessment.tokens.map((token) => ({
      mint: token.mint,
      engineVersion: assessment.engineVersion,
      samples: token.samples,
      medianSignedBps: token.medianSignedBps,
      medianAbsBps: token.medianAbsBps,
      generousSamples: token.generousSamples,
      severity: token.severity,
    })),
    Date.now(),
    suspensions,
  );

  for (const suspension of suspensions) {
    current.suspended += 1;
    console.error(`[drift] suspended ${suspension.mint}: ${assessment.summary}`);
  }

  current.lastRunAt = Date.now();
  current.lastSummary = assessment.summary;
  current.cycles += 1;

  if (assessment.overall !== 'ok') {
    console.warn(`[drift] ${assessment.summary}`);
  }
}

/** Start the loop. Does nothing if it is already going. */
export function startDriftWatch(): void {
  const current = state();
  if (current.running) return;
  current.running = true;

  const tick = (): void => {
    void runDriftCycle()
      .then(() => {
        // A completed cycle, even one that measured nothing, clears the wedged
        // signal. Only a throw before completion counts as a failure.
        state().failures = 0;
      })
      .catch((error) => {
        // A monitor that can kill the server is worse than no monitor. But a
        // cycle that throws before it can update lastRunAt would otherwise leave
        // the health surface reporting a frozen monitor as fine, so count it.
        state().failures += 1;
        console.error('[drift] cycle failed', error);
      });
  };

  const first = setTimeout(() => {
    tick();
    current.timer = setInterval(tick, INTERVAL_MS);
    // Node keeps the process alive for a pending interval, which would hold a
    // shutdown open for half an hour.
    current.timer.unref?.();
  }, FIRST_RUN_MS);
  first.unref?.();

  console.log('[drift] watching the engine against the market');
}
