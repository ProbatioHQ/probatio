import 'server-only';
import {
  curvesToRefresh,
  progressBpsFor,
  recordCurveStates,
  type CurveWrite,
} from '@probatio/db';
import { RpcClient, decodeBondingCurve } from '@probatio/pools';
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
          complete: curve.complete,
        });
      } catch {
        // A curve that will not decode is one token missing from a lane, not
        // a reason to drop the other ninety-nine in the batch.
      }
    }
  }

  if (states.length === 0) return;

  await recordCurveStates(client, states, now);
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

export function startCurveWatch(): void {
  if (started) return;
  started = true;

  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000, minIntervalMs: 120 });

  const run = (): void => {
    void pass(rpc).catch((error) => {
      console.error('[curves] pass failed', error);
    });
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
