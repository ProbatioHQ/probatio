import {
  DAILY_TRADE_CAP,
  DEFAULT_RULES,
  MAX_STAKE_LAMPORTS,
  MIN_STAKE_LAMPORTS,
} from '@probatio/sim';
import { automatedTradesSince } from '@probatio/db';
import { noteActivity } from '@/lib/activity';
import { db } from '@/lib/db';
import { executeTrade, type MarketReader } from '@/lib/execute-trade';
import { rateLimit } from '@/lib/rate-limit';
import { resolveFill, resolveMint } from '@/lib/rpc';
import { activeSeason } from '@/lib/season';
import { authenticate, refuse } from '@/lib/strategy-auth';

/**
 * Place an order from a program.
 *
 * The whole point of this endpoint is that it is not a shortcut. It authenticates
 * differently from the website and then does exactly what the website does: reads
 * the pool, waits out the season's latency, reads again, quotes against the second
 * reading, and writes the same sealed record. A key buys a way in, not an
 * advantage, and a record made through it ranks beside a record made by clicking
 * because it was made the same way.
 *
 * The sequence itself is in `executeTrade` and is not this route's property. It
 * is the fourth caller, after the trade route, the free-play accounts and the
 * hosted strategy runner, and the reason it was lifted out of a route in the
 * first place was so that this one could not be a fifth copy of it.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_SLIPPAGE_BPS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

/*
 * The same two reads, with the same refusal to share the second one. See the
 * trade route: coalescing the fill's read would let it latch onto a read that
 * began before this order's delay elapsed, which hands back the pre-delay
 * execution the delay exists to deny.
 */
const MARKET: MarketReader = { atClick: resolveMint, atFill: resolveFill };

export async function POST(request: Request): Promise<Response> {
  /*
   * Authenticated first, then throttled by whose key it is.
   *
   * The order matters. Throttling first would count this request against a
   * network address, because a program sends no session cookie, so two bots
   * behind one connection would throttle each other while the key in the header
   * named each of them exactly. Authenticating costs one indexed lookup of a
   * hash, and a caller with no valid key is still bounded by address below.
   */
  const { auth, client } = await authenticate(request);
  if (!auth.ok) {
    // Bounded by address, since there is no wallet to bound it by.
    const flood = await rateLimit(request, 'api-order');
    if (flood.response) return flood.response;
    return refuse(auth.status, auth.error);
  }
  if (!client) return refuse(503, 'The database is unavailable.');

  /*
   * Throttled harder than the website, under its own bucket.
   *
   * A person clicks a few times a minute; a loop can ask a thousand times in the
   * same minute without meaning any harm. Sharing the website's bucket would
   * mean one busy program throttling the people trading by hand.
   */
  const throttled = await rateLimit(request, 'api-order', 1, auth.pubkey);
  if (throttled.response) return throttled.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse(400, 'Expected a JSON body.');
  }

  const { mint, side, size, slippageBps } = (body ?? {}) as Record<string, unknown>;

  if (typeof mint !== 'string' || !MINT_PATTERN.test(mint)) {
    return refuse(400, 'A valid mint is required.', 'mint should be the token’s base58 address.');
  }
  if (side !== 'buy' && side !== 'sell') {
    return refuse(400, 'side must be "buy" or "sell".');
  }
  if (typeof size !== 'string' || !/^[1-9]\d*$/.test(size)) {
    return refuse(
      400,
      'size must be a positive integer, as a string.',
      'Lamports for a buy, token base units for a sell. A JSON number cannot hold a lamport balance without rounding it, which is why this is a string.',
    );
  }

  const amount = BigInt(size);
  if (side === 'buy' && (amount < MIN_STAKE_LAMPORTS || amount > MAX_STAKE_LAMPORTS)) {
    return refuse(
      400,
      `A buy has to be between ${MIN_STAKE_LAMPORTS} and ${MAX_STAKE_LAMPORTS} lamports.`,
      'Below the floor a position is not worth the two fees it costs to open and close.',
    );
  }

  const slippage =
    typeof slippageBps === 'number' && Number.isFinite(slippageBps)
      ? Math.min(Math.max(Math.trunc(slippageBps), 0), MAX_SLIPPAGE_BPS)
      : DEFAULT_RULES.slippageBps;

  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, auth.pubkey, now);

  /*
   * The daily count, shared with the hosted runner.
   *
   * One account running a strategy here and a program of their own is still one
   * account, and the cost this bounds is chain reads rather than intent. Counted
   * from the trades themselves so that a restart, or two servers during a
   * deploy, cannot lose track of it.
   */
  const spent = await automatedTradesSince(client, account.id, now - DAY_MS);
  if (spent >= DAILY_TRADE_CAP) {
    return refuse(
      429,
      `You have placed ${spent} automated orders in the last day, and the cap is ${DAILY_TRADE_CAP}.`,
      'Every fill reads the chain twice, so this is what stops one runaway loop spending a month of the site’s allowance in a day. It frees up as the day rolls forward.',
    );
  }

  const outcome = await executeTrade({
    client,
    account,
    seasonId,
    userPubkey: auth.pubkey,
    mint,
    side,
    size: amount,
    slippageBps: slippage,
    market: MARKET,
    source: 'api',
    now,
  });

  // The same codes the website gets, for the same reasons: a suspension is a
  // conflict, an unreadable chain is unavailable, and a rejection is a real
  // outcome at 200 because a reverted transaction is not an error.
  if (outcome.status === 'suspended') return refuse(409, outcome.detail);
  if (outcome.status === 'degraded') return refuse(503, outcome.detail);
  if (outcome.status === 'unlisted') return refuse(409, outcome.detail);
  if (outcome.status === 'rejected') {
    return Response.json({
      status: 'rejected',
      reason: outcome.reason,
      detail: outcome.detail,
      ...(outcome.expected === undefined ? {} : { expected: outcome.expected }),
    });
  }

  await noteActivity(client, auth.pubkey, true, now);

  return Response.json({
    status: 'filled',
    ...outcome.fill,
    ordersLeftToday: Math.max(0, DAILY_TRADE_CAP - spent - 1),
  });
}
