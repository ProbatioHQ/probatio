import 'server-only';
import { LaunchFeed, LogSubscription, toWebSocketUrl } from '@probatio/feed';
import { PUMP_PROGRAM_ID, extractTradeEvents } from '@probatio/pools';
import { recordLaunches } from '@probatio/db';
import { db } from './db';
import { reportFeedRunning, reportFeedState } from './health';
import { publishLaunches } from './launch-stream';
import { resolveLaunchImages } from './token-images';
import { ingestTradeEvents, startTradeCandles } from './trade-candles';
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
      const now = Date.now();
      await recordLaunches(await db(), batch, now);
      // Published after the write, so a tab never shows a launch that failed
      // to persist and vanishes on the next reload. A reconnecting socket
      // replays recent history, so the batch can contain launches already
      // sent; readers key by mint and drop the repeats.
      publishLaunches(batch.map((launch) => ({ ...launch, firstSeenAt: now })));
      void resolveLaunchImages(batch.map((launch) => launch.mint));
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

      // The same messages carry every trade. Charts are built from these
      // rather than from the curve watcher's samples: one sample per bucket
      // makes open, high, low and close the same number, and every candle
      // draws as a flat line.
      const trades = extractTradeEvents(notification.logs);
      if (trades.length > 0) ingestTradeEvents(trades);
    },
  });

  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // Never the reason the process stays alive.
  timer.unref?.();

  startTradeCandles();
  reportFeedRunning();
  subscription.start();
}

export function stopLiveFeed(): void {
  subscription?.stop();
  subscription = null;
  started = false;
}
