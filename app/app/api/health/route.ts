import { capabilities, overall } from '@probatio/health';
import { rateLimit } from '@/lib/rate-limit';
import { downNow } from '@/lib/health';

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
      capabilities: states.filter((state) => state.level !== 'ok'),
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
