import 'server-only';
import { recordLaunches } from '@probatio/db';
import { db } from './db';
import { reportFeedNotification, reportFeedRunning, reportFeedState } from './health';
import { publishLaunches } from './launch-stream';
import { resolveLaunchImages } from './token-images';

/**
 * New launches, from pump.fun rather than from the chain.
 *
 * WHY THIS EXISTS
 *
 * The launch feed used to be a `logsSubscribe` on the whole pump.fun program:
 * every transaction touching it, streamed into this process, for ever. It was
 * the most expensive thing the site owned by a wide margin, it ran whether
 * anybody was on the site or not, and it billed per message on a metered
 * endpoint. Ten million credits went in six days, the provider halted the
 * account, and the site went down with nothing wrong with it.
 *
 * It was also the wrong shape for the job. A launch is one transaction in
 * thousands, so the firehose was paid for in full and discarded almost
 * entirely.
 *
 * pump.fun publishes its own list of coins by creation time. It is the same
 * data, from the people who created it, on the same service this app already
 * reads for Explore, movers, search and chart history, and it costs nothing.
 * Polling it is not a downgrade from reading the chain; for this particular
 * question it is the more direct source.
 *
 * WHAT IS GIVEN UP
 *
 * The socket carried every trade as well, and those built live candles. This
 * does not, and cannot. Charts are not left behind by it: a token somebody is
 * looking at is refreshed from pump.fun's own candle service for as long as
 * they keep looking, which is where the history came from anyway. What is lost
 * is candle writes for tokens nobody has open, which nobody was watching by
 * definition.
 */

/**
 * How often to ask.
 *
 * Ten seconds. pump.fun mints a handful of coins a minute at its busiest, so a
 * page of fifty is many times the headroom needed to miss nothing between
 * polls, and six requests a minute to somebody else's service is a good guest.
 */
const POLL_MS = 10_000;

/** How many to ask for. Sized so a burst between polls cannot overflow it. */
const PAGE_SIZE = 50;

const LIST = 'https://frontend-api-v3.pump.fun/coins';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * Mints already seen, so a poll only reports what is new.
 *
 * Every poll returns the same newest fifty, most of which were in the last one.
 * Bounded, because this process runs for weeks: past the ceiling the oldest
 * half is dropped, and the worst that can happen is one launch being written
 * twice, which `recordLaunches` already ignores on conflict.
 */
const SEEN_MAX = 2_000;
const seen = new Set<string>();

function firstTime(mint: string): boolean {
  if (seen.has(mint)) return false;
  seen.add(mint);
  if (seen.size > SEEN_MAX) {
    for (const old of [...seen].slice(0, SEEN_MAX / 2)) seen.delete(old);
  }
  return true;
}

interface Coin {
  mint?: unknown;
  bonding_curve?: unknown;
  creator?: unknown;
  name?: unknown;
  symbol?: unknown;
  metadata_uri?: unknown;
  created_timestamp?: unknown;
}

const text = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * One coin as a launch, or null.
 *
 * A launch with no mint or no curve cannot be traded or priced, so it is
 * dropped rather than written as a row that every later read has to special
 * case. The rest is best effort: a token genuinely can have no name.
 */
function toLaunch(coin: Coin, now: number): Parameters<typeof recordLaunches>[1][number] | null {
  const mint = text(coin.mint, 44);
  const bondingCurve = text(coin.bonding_curve, 44);
  if (!mint || !bondingCurve) return null;

  const created = Number(coin.created_timestamp);
  return {
    mint,
    bondingCurve,
    creator: text(coin.creator, 44),
    name: text(coin.name),
    symbol: text(coin.symbol, 32),
    uri: text(coin.metadata_uri, 400),
    // pump.fun stamps this in milliseconds. Anything absent or absurd is called
    // now, because a launch with no time sorts to 1970 and sits at the bottom
    // of a feed ordered by when things happened.
    launchedAt: Number.isFinite(created) && created > 0 ? created : now,
    /*
     * No slot, and there is no honest way to invent one.
     *
     * The socket knew which slot a launch landed in because it was reading the
     * chain. This is reading a list. The column is nullable precisely so a
     * source that does not know can say so rather than write a plausible
     * number nobody can check.
     */
    slot: null,
  };
}

/** One poll. Exported so a test can run exactly one against a fake fetch. */
export async function pollLaunches(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<number> {
  const url = `${LIST}?offset=0&limit=${PAGE_SIZE}&sort=created_timestamp&order=DESC&includeNsfw=false`;

  let body: unknown;
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      reportFeedState(false);
      return 0;
    }
    body = await response.json();
  } catch {
    // Their service, not ours, and it will be asked again in ten seconds. The
    // state is reported so a long outage is recorded rather than only logged.
    reportFeedState(false);
    return 0;
  }

  reportFeedState(true);
  /*
   * A poll that answered is proof the source is alive, whether or not anything
   * was new. The silence watchdog exists to catch a feed that is connected and
   * delivering nothing, and a quiet minute on pump.fun is not that.
   */
  reportFeedNotification();

  if (!Array.isArray(body)) return 0;

  const fresh: Parameters<typeof recordLaunches>[1][number][] = [];
  for (const coin of body as Coin[]) {
    const launch = toLaunch(coin, now);
    if (launch && firstTime(launch.mint)) fresh.push(launch);
  }
  if (fresh.length === 0) return 0;

  // Oldest first, so the feed reads in the order things actually happened.
  fresh.reverse();

  try {
    await recordLaunches(await db(), fresh, now);
  } catch (error) {
    /*
     * Dropped rather than retried, and the mints stay marked as seen.
     *
     * Retrying would mean holding a growing batch across a database outage, and
     * the next poll brings the same page back anyway. A launch lost to a failed
     * write is a row missing from a feed, which the page recovers on reload.
     */
    console.error('[feed] could not record launches', error);
    return 0;
  }

  // Published after the write, so a tab never shows a launch that failed to
  // persist and vanishes on the next reload.
  publishLaunches(fresh.map((launch) => ({ ...launch, firstSeenAt: now })));
  void resolveLaunchImages(fresh.map((launch) => launch.mint));

  return fresh.length;
}

let started = false;

export function startPolledFeed(): void {
  if (started) return;
  started = true;

  reportFeedRunning();

  const tick = (): void => {
    void pollLaunches().catch((error) => {
      console.error('[feed] poll failed', error);
    });
  };

  const timer = setInterval(tick, POLL_MS);
  // Never the reason the process stays alive.
  timer.unref?.();
  tick();

  console.log('[feed] polling pump.fun for launches');
}

/** Used by tests, so one does not inherit another's idea of what is new. */
export function resetPolledFeed(): void {
  seen.clear();
  started = false;
}
