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
const feedState = { running: false, connected: false, startedAt: 0 };

/** A socket needs a moment to connect. Below this, silence is not an outage. */
const CONNECT_GRACE_MS = 20_000;

export function reportFeedRunning(): void {
  feedState.running = true;
  feedState.startedAt = Date.now();
}

export function reportFeedState(connected: boolean): void {
  feedState.connected = connected;
}

function feedFailure(): string | null {
  if (!feedState.running) return 'feed not running on this instance';
  if (feedState.connected) return null;

  // Still connecting. Reporting that as an outage put "new launches are not
  // arriving" on the front page while launches were visibly arriving, which is
  // worse than saying nothing: it teaches people the banner is noise.
  if (Date.now() - feedState.startedAt < CONNECT_GRACE_MS) return null;

  return 'websocket disconnected';
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

  // A feature that was never switched on is absent, not broken. Recording it
  // as an outage put a permanent warning strip across every page for something
  // nobody had asked for, which is how a banner teaches people to ignore it.
  // If the key is set and the calls fail, that is a different thing and the
  // coach route reports it where it happens.
  if (coachApiKey() !== null) await record('coach', null, now);
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
