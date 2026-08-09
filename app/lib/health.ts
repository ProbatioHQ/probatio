import 'server-only';
import { RpcClient } from '@probatio/pools';
import { closeOutage, openOutage, openOutages } from '@probatio/db';
import type { Dependency } from '@probatio/health';
import { db } from './db';
import { coachApiKey, rpcEndpoint } from './env';

/**
 * Noticing that something is down, and writing it down.
 *
 * The writing down is the point. A status page that only knows the present
 * cannot answer the question the void policy asks — how many minutes was the
 * feed unavailable during this season — and that question decides whether a
 * prize pool is paid.
 *
 * Probes are cheap and deliberately shallow. A probe that does real work is a
 * probe that can take the site down when the thing it is checking is slow.
 */

const PROBE_INTERVAL_MS = 30_000;
let started = false;

/**
 * Remembered so the feed's own reconnect logic can report through here.
 *
 * Starts disconnected and not running. Defaulting to connected would report a
 * healthy feed on a server where the feed was never started — which is a lie
 * that looks like good news, the worst kind for a status page to tell.
 */
const feedState = { running: false, connected: false };

export function reportFeedRunning(): void {
  feedState.running = true;
}

export function reportFeedState(connected: boolean): void {
  feedState.connected = connected;
}

function feedFailure(): string | null {
  if (!feedState.running) return 'feed not running on this instance';
  return feedState.connected ? null : 'websocket disconnected';
}

async function probeRpc(): Promise<string | null> {
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 8_000, maxRetries: 0 });
    await rpc.getSlot();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : 'unreachable';
  }
}

async function record(dependency: Dependency, failure: string | null, now: number): Promise<void> {
  const client = await db();
  if (failure === null) await closeOutage(client, dependency, now);
  else await openOutage(client, dependency, now, failure);
}

export async function probeOnce(): Promise<void> {
  const now = Date.now();

  // The database is probed by being used. If this throws, nothing below can be
  // written anyway, and an outage nobody can record is one the next healthy
  // process will notice.
  await record('rpc', await probeRpc(), now);
  await record('feed', feedFailure(), now);
  await record('coach', coachApiKey() === null ? 'not configured' : null, now);
}

export function startProbing(): void {
  if (started) return;
  started = true;

  const tick = (): void => {
    void probeOnce().catch((error) => {
      console.error('[health] probe failed', error);
    });
  };

  tick();
  const timer = setInterval(tick, PROBE_INTERVAL_MS);
  timer.unref?.();
}

/** Which dependencies are down right now, for the status endpoint. */
export async function downNow(): Promise<Dependency[]> {
  try {
    const rows = await openOutages(await db());
    return [...new Set(rows.map((row) => row.dependency))];
  } catch {
    // The database is what could not be read, so it is what is down.
    return ['database'];
  }
}
