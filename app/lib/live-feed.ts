import 'server-only';
import { LaunchFeed, LogSubscription, toWebSocketUrl } from '@probatio/feed';
import { PUMP_PROGRAM_ID } from '@probatio/pools';
import { recordLaunches } from '@probatio/db';
import { db } from './db';
import { reportFeedRunning, reportFeedState } from './health';
import { rpcEndpoint } from './env';

/**
 * The launch feed, running for as long as the server does.
 *
 * Without this the token list only grows when somebody runs a script, which
 * means a visitor can arrive at a site whose newest token is hours old — for a
 * product about trading launches, indistinguishable from broken.
 *
 * Writes are best-effort by design. A feed that takes the server down with it
 * would trade a stale list for no site at all.
 */

let started = false;
let subscription: LogSubscription | null = null;

/** How many launches to hold before writing. */
const BATCH_SIZE = 25;
/** How long to hold a partial batch. Quiet minutes still reach the page. */
const FLUSH_INTERVAL_MS = 5_000;

export function startLiveFeed(): void {
  // `register` can fire more than once across dev reloads, and two
  // subscriptions would double every insert attempt for no benefit.
  if (started) return;
  started = true;

  const feed = new LaunchFeed();
  let pending: Parameters<typeof recordLaunches>[1][number][] = [];
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const batch = pending;
    pending = [];
    try {
      await recordLaunches(await db(), batch, Date.now());
    } catch (error) {
      // Dropped rather than retried: these arrive continuously, and a batch
      // held across a database outage would grow without limit.
      console.error('[feed] could not record launches', error);
    } finally {
      flushing = false;
    }
  }

  subscription = new LogSubscription({
    endpoint: toWebSocketUrl(rpcEndpoint()),
    mentions: PUMP_PROGRAM_ID,
    onStatus: (status, detail) => {
      // Reported so an outage is recorded rather than only logged. The void
      // policy asks how long the feed was down, and a log cannot answer it.
      reportFeedState(status === 'subscribed' || status === 'open');
      if (status === 'subscribed') console.log('[feed] live');
      else if (status === 'closed' && detail) console.warn(`[feed] ${detail}, reconnecting`);
    },
    onNotification: (notification) => {
      for (const launch of feed.ingest(notification)) pending.push(launch);
      if (pending.length >= BATCH_SIZE) void flush();
    },
  });

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // Never the reason the process stays alive.
  timer.unref?.();

  reportFeedRunning();
  subscription.start();
}

export function stopLiveFeed(): void {
  subscription?.stop();
  subscription = null;
  started = false;
}
