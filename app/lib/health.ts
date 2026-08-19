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
interface FeedState {
  running: boolean;
  connected: boolean;
  startedAt: number;
  /** When the socket last delivered a message, to catch a silent-but-open one. */
  lastNotificationAt: number;
}

/**
 * On `globalThis`, and this is the third time.
 *
 * `instrumentation.ts` and a route handler compile into separate bundles, so a
 * module-level object here exists once per bundle. The feed reports its state
 * from the instrumentation side; anything reading it from a route sees a copy
 * that is never written to and therefore permanently reports a dead feed.
 *
 * The health endpoint never noticed because it answers from outage rows in the
 * database, which both bundles share. The moment something read this object
 * directly — a "streaming" indicator that wanted to know whether launches were
 * actually arriving — it read false forever, on a perfectly healthy feed.
 *
 * The launch stream registry and the open-stream counter are on `globalThis`
 * for exactly this reason. Anything in `app/lib` that holds state written by a
 * background worker and read by a request belongs there too.
 */
const FEED_KEY = Symbol.for('probatio.feed-state');

function feedStateStore(): FeedState {
  const store = globalThis as typeof globalThis & { [FEED_KEY]?: FeedState };
  store[FEED_KEY] ??= { running: false, connected: false, startedAt: 0, lastNotificationAt: 0 };
  return store[FEED_KEY];
}

/** A socket needs a moment to connect. Below this, silence is not an outage. */
const CONNECT_GRACE_MS = 20_000;
/**
 * How long an open socket may deliver nothing before it counts as down.
 *
 * The pump.fun program emits a message for every launch and every trade, which
 * is near-continuous, so minutes of total silence on an open socket means the
 * node has wedged: connected, delivering nothing, and no close or error to say
 * so. Generous enough that a genuinely quiet stretch does not trip it.
 */
const FEED_SILENCE_MS = 180_000;

export function reportFeedRunning(): void {
  const feedState = feedStateStore();
  feedState.running = true;
  feedState.startedAt = Date.now();
}

export function reportFeedState(connected: boolean): void {
  feedStateStore().connected = connected;
}

/** Marks that the socket delivered a message, for the silence watchdog. */
export function reportFeedNotification(): void {
  feedStateStore().lastNotificationAt = Date.now();
}

/**
 * A socket that is open but has stopped delivering. The reference is the later
 * of connect and the last message, so a fresh connection keeps its grace and a
 * busy feed never trips.
 */
function feedSilent(feedState: FeedState, now: number): boolean {
  if (!feedState.running || !feedState.connected) return false;
  const since = Math.max(feedState.startedAt, feedState.lastNotificationAt);
  return now - since > FEED_SILENCE_MS;
}

/**
 * Whether launches can actually arrive right now.
 *
 * The feed page showed "streaming" whenever its own connection to this server
 * was open, which says nothing about whether this server is hearing anything
 * from Solana. With the upstream feed down the page claimed to be streaming
 * while the banner directly above it said new launches were not arriving —
 * two true-ish statements that contradict each other, on the same screen.
 */
export function feedIsLive(): boolean {
  const feedState = feedStateStore();
  return feedState.running && feedState.connected && !feedSilent(feedState, Date.now());
}

function feedFailure(): string | null {
  const feedState = feedStateStore();
  if (!feedState.running) return 'feed not running on this instance';
  const now = Date.now();

  if (!feedState.connected) {
    // Still connecting. Reporting that as an outage put "new launches are not
    // arriving" on the front page while launches were visibly arriving, which
    // is worse than saying nothing: it teaches people the banner is noise.
    if (now - feedState.startedAt < CONNECT_GRACE_MS) return null;
    return 'websocket disconnected';
  }

  // Open but silent. A wedged node holds the socket up while delivering
  // nothing, and a status page that reads that as healthy is telling the lie
  // this module exists to avoid.
  if (feedSilent(feedState, now)) return 'feed connected but not delivering';
  return null;
}

async function probeRpc(): Promise<string | null> {
  try {
    // Retries, where this used to take the first answer as final. A paid
    // endpoint returns 429 "connection rate limits exceeded" under load, and
    // treating one of those as an outage is how a healthy site tells visitors
    // it is unavailable. Measured against the endpoint in use: ten getSlot
    // calls in a row all returned 429 while the site was serving normally.
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 8_000, maxRetries: 2 });
    await rpc.getSlot();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : 'unreachable';
  }
}

/**
 * How many probes in a row must fail before a dependency is called down.
 *
 * Slow to alarm, immediate to recover. One failed probe used to open an outage
 * on its own, which put a 503 on /api/health and an outage banner across every
 * page for a blip that was over before anyone read it. At a thirty second
 * interval, three in a row is a minute and a half of genuine unreachability
 * before the site says so, and a single success clears it at once.
 *
 * The counter is deliberately not persisted. It describes the last few seconds
 * of one process, and a restart should start from a clean slate rather than
 * inherit suspicion from a process that is gone.
 */
const FAILURES_BEFORE_DOWN = 3;
const STRIKES_KEY = Symbol.for('probatio.probe-strikes');

function strikes(): Map<Dependency, number> {
  const store = globalThis as typeof globalThis & { [STRIKES_KEY]?: Map<Dependency, number> };
  store[STRIKES_KEY] ??= new Map<Dependency, number>();
  return store[STRIKES_KEY];
}

/** Record a probe result, holding off on an outage until it has happened thrice. */
async function recordSteady(
  dependency: Dependency,
  failure: string | null,
  now: number,
): Promise<void> {
  const counts = strikes();
  if (failure === null) {
    counts.set(dependency, 0);
    await record(dependency, null, now);
    return;
  }
  const count = (counts.get(dependency) ?? 0) + 1;
  counts.set(dependency, count);
  if (count < FAILURES_BEFORE_DOWN) {
    console.warn(`[health] ${dependency} probe failed (${count}/${FAILURES_BEFORE_DOWN})`, failure);
    return;
  }
  await record(dependency, failure, now);
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
  await recordSteady('rpc', await probeRpc(), now);
  await recordSteady('feed', feedFailure(), now);

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
