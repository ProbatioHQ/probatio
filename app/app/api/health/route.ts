import { capabilities, overall } from '@probatio/health';
import { rateLimit } from '@/lib/rate-limit';
import { downNow } from '@/lib/health';
import { launchListenerCount, openStreamCount } from '@/lib/launch-stream';
import { pendingTradeMints } from '@/lib/trade-candles';
import { driftStatus } from '@/lib/drift-watch';
import { priceStreamStatus } from '@/lib/price-stream';
import { storageStats, writeProbe } from '@/lib/db-reclaim';

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
      // The push feed behind live prices.
      prices: priceStreamStatus(),
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
