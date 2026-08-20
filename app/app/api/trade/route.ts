import { DEFAULT_RULES } from '@probatio/sim';
import { db } from '@/lib/db';
import { executeTrade, type MarketReader } from '@/lib/execute-trade';
import { rateLimit } from '@/lib/rate-limit';
import { noteActivity } from '@/lib/activity';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';
import { resolveFill, resolveMint } from '@/lib/rpc';

/**
 * Execute a trade.
 *
 * The latency is real. The pool is read when the click arrives, the request
 * then waits exactly as long as the season's rules say a transaction takes,
 * and the fill is computed against the pool as it stands *after* that wait.
 *
 * Simulating the delay by quoting twice against one reading would be cheaper
 * and would be a lie: the whole reason this product exists is that other paper
 * traders fill you at the price on screen. Here the price genuinely moves while
 * you wait, and sometimes the trade genuinely fails.
 *
 * The sequence itself lives in `executeTrade`, because it is not this route's
 * property. The accounts trading free play run it, and the Telegram bot will
 * run it, and three copies of a sequence whose every step exists for a reason
 * is how they quietly stop agreeing with each other.
 *
 * What is left here is what a route should be: authentication, the shape of the
 * request, and turning an outcome into a response.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_SLIPPAGE_BPS = 10_000;

/*
 * The two reads a fill needs, and they are not the same read.
 *
 * The click may share an in-flight read with everybody else looking at the same
 * token. The fill never shares: coalescing would let it latch onto a read that
 * began before this trade's delay elapsed, handing back the pre-delay execution
 * the delay is there to prevent.
 */
const MARKET: MarketReader = { atClick: resolveMint, atFill: resolveFill };

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'trade');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) {
    return Response.json({ error: 'sign in to trade' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const { mint, size, slippageBps } = (body ?? {}) as Record<string, unknown>;
  const side = (body as { side?: unknown }).side as 'buy' | 'sell' | undefined;

  if (typeof mint !== 'string' || !MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint is required' }, { status: 400 });
  }
  if (side !== 'buy' && side !== 'sell') {
    return Response.json({ error: 'side must be buy or sell' }, { status: 400 });
  }
  const tradeSide: 'buy' | 'sell' = side;
  if (typeof size !== 'string' || !/^[1-9]\d*$/.test(size)) {
    // Sizes arrive as decimal strings of base units. A JSON number cannot hold
    // a lamport balance without rounding it.
    return Response.json({ error: 'size must be a positive integer string' }, { status: 400 });
  }

  const slippage =
    typeof slippageBps === 'number' && Number.isFinite(slippageBps)
      ? Math.min(Math.max(Math.trunc(slippageBps), 0), MAX_SLIPPAGE_BPS)
      : DEFAULT_RULES.slippageBps;

  const client = await db();
  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, user.pubkey, now);

  const outcome = await executeTrade({
    client,
    account,
    seasonId,
    userPubkey: user.pubkey,
    mint,
    side: tradeSide,
    size: BigInt(size),
    slippageBps: slippage,
    market: MARKET,
    now,
  });

  // Each refusal keeps the status code it had: a suspension is a conflict, an
  // unreadable chain is unavailable, and a rejection is a real outcome at 200
  // because a reverted transaction is not an error.
  if (outcome.status === 'suspended') {
    return Response.json({ error: outcome.detail, suspended: true }, { status: 409 });
  }
  if (outcome.status === 'degraded') {
    return Response.json({ error: outcome.detail, degraded: true }, { status: 503 });
  }
  if (outcome.status === 'unlisted') {
    return Response.json({ error: outcome.detail }, { status: 409 });
  }
  if (outcome.status === 'rejected') {
    return Response.json({
      status: 'rejected',
      reason: outcome.reason,
      detail: outcome.detail,
      ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
    });
  }

  // Recorded after the fill landed, so activation means a trade that happened
  // rather than one that was attempted.
  await noteActivity(client, user.pubkey, true, now);

  return Response.json({ status: 'filled', ...outcome.fill });
}
