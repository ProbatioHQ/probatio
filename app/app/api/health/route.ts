import { capabilities, overall } from '@probatio/health';
import { governorStats } from '@probatio/pools';
import { rateLimit } from '@/lib/rate-limit';
import { downNow } from '@/lib/health';
import { launchListenerCount, openStreamCount } from '@/lib/launch-stream';
import { pendingTradeMints } from '@/lib/trade-candles';
import { driftStatus } from '@/lib/drift-watch';
import { warmStats } from '@/lib/chart-warm';
import { traderWarmStats } from '@/lib/trader-warm';
import { houseTraderStats } from '@/lib/house-traders';
import { duelSettlerStatus } from '@/lib/duel-settle';
import { strategyRunnerStatus } from '@/lib/strategy-runner';
import { markStats } from '@/lib/mark-prices';
import { priceStreamStatus } from '@/lib/price-stream';
import { seasonProbe, storageStats, writeProbe } from '@/lib/db-reclaim';
import { snapshotState } from '@/lib/account-backup';
import { seasonReadiness } from '@/lib/prize';

/**
 * What the site can currently do.
 *
 * Public, and phrased in terms of capabilities rather than components. Nobody
 * outside cares whether an RPC provider is timing out; they care whether they
 * can trade, and whether the number on the leaderboard means what it usually
 * means.
 */

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const down = await downNow();
  const states = capabilities(down);
  const level = overall(states);

  return Response.json(
    {
      status: level,
      /*
       * Which build is answering.
       *
       * Added after several rounds of looking at a page, deciding a fix had not
       * worked, and rewriting code that was never deployed. A screenshot cannot
       * say which commit produced it, and neither could this endpoint, so
       * "still broken" and "not shipped yet" were indistinguishable from the
       * outside. Railway sets this on every deploy.
       */
      build: process.env['RAILWAY_GIT_COMMIT_SHA']?.slice(0, 7) ?? 'local',
      down,
      /*
       * Room on the volume.
       *
       * When it runs out, reads keep working and every write fails, so a probe
       * that reads reports a healthy database while nothing can be recorded.
       * This is the number that says so.
       */
      storage: storageStats(),
      /* Whether a write actually lands, and what it says if it does not. */
      writable: await writeProbe(),
      /* Each step of resolving an account, so the failing one names itself. */
      season: await seasonProbe(),
      /* The account safety net: that it exists, and what it is holding. */
      backup: snapshotState(),
      /* Whether a ranked season could commit and could pay. */
      readiness: seasonReadiness(),
      capabilities: states.filter((state) => state.level !== 'ok'),
      /*
       * The live subsystems, counted rather than assumed.
       *
       * These are the things that fail quietly. A stream registry that has
       * drifted from the number of open connections means slots are leaking;
       * a trade buffer pinned at its ceiling means candles are being dropped.
       * Neither shows up as an outage, and neither is visible at all without
       * a number to look at.
       */
      live: {
        openStreams: openStreamCount(),
        streamSubscribers: launchListenerCount(),
        bufferedTradeMints: pendingTradeMints(),
      },
      /*
       * The engine-against-reality check.
       *
       * Reported whether or not it has found anything, because the useful
       * failure is not "drift detected" — it is a monitor that stopped running
       * weeks ago and left everything looking fine.
       */
      drift: driftStatus(),
      /*
       * Charts being filled in ahead of anybody asking.
       *
       * A silent background job is the kind that stops without anyone noticing,
       * and the symptom here is not an error: it is the volume quietly staying
       * empty while the largest tokens keep opening slowly. `resident` against
       * `budget` says how far through its cycle it is.
       */
      warm: warmStats(),
      /* The harvester behind the real-trader board. */
      traders: traderWarmStats(),
      /* The accounts trading free play through the engine. */
      house: houseTraderStats(),
      /* Strategies people wrote in the form, running on our clock. */
      strategies: strategyRunnerStatus(),
      /*
       * Duels scored after their window closed.
       *
       * `settled` climbing is the only proof this ran. A duel left live past its
       * end is the failure that makes no noise: both traders stay marked as
       * duelling, neither can start another, and no result is ever written.
       */
      duels: duelSettlerStatus(),
      /*
       * Prices kept on what people hold.
       *
       * `holding` against `priced` is the number that says whether the
       * leaderboard can move at all: everything held and nothing priced is a
       * board marked at cost, which reads as every trader flat forever.
       */
      marks: markStats(),
      // The push feed behind live prices.
      prices: priceStreamStatus(),
      /*
       * The shared budget every background reader draws on.
       *
       * Here because the failure it exists to prevent was invisible from the
       * outside: a dozen individually well behaved workers adding up to a rate
       * limit, and the site reporting the chain unreadable when nothing was
       * wrong with the chain. `floorMs` climbing above its base is the endpoint
       * pushing back, and `cooling` is every sweep currently standing down.
       * Keyed by host, never by URL, because the endpoint carries the API key.
       */
      rpcBudget: governorStats(),
      // Stated whatever the status, because the promise matters most when
      // something is broken.
      promise:
        'Trading stops when live prices cannot be read. It never falls back to a ' +
        'cached price, because a fill quoted against a stale price is not a fill.',
    },
    // 503 when something is genuinely unavailable, so uptime checks and load
    // balancers see it rather than having to parse the body.
    { status: level === 'unavailable' ? 503 : 200 },
  );
}
