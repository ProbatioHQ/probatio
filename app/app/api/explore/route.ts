import { movers } from '@/lib/explore';
import { rateLimit } from '@/lib/rate-limit';

/**
 * What is moving right now.
 *
 * The ranking is not this site's. There is price history here for only the
 * couple of hundred tokens somebody has opened, so the candidates come from
 * pump.fun's own listing and the hour's change from DEX Screener, and this
 * endpoint says so in its own body rather than leaving a reader to assume the
 * numbers were derived here.
 *
 * Cached upstream, so a burst of readers is one round of outside calls.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const requested = Number(new URL(request.url).searchParams.get('limit') ?? '24');
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 48) : 24;

  try {
    const board = await movers(limit);
    return Response.json({
      movers: board,
      // Named in the payload, not just in the page, so anything reading this
      // API inherits the caveat rather than having to know it.
      ranking:
        'hourly price change from DEX Screener, over pump.fun listings, minimum $500 of 24h volume',
    });
  } catch (error) {
    console.error('[explore] could not build the board', error);
    return Response.json(
      { error: 'could not reach the services this page ranks from' },
      { status: 503 },
    );
  }
}
