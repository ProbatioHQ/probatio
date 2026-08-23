import { DAILY_TRADE_CAP, DEFAULT_RULES } from '@probatio/sim';
import {
  automatedTradesSince,
  currentRankedSeason,
  lastPrices,
  openPositions,
} from '@probatio/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { authenticate, refuse } from '@/lib/strategy-auth';

/**
 * What a program needs to know before it can size an order.
 *
 * Balance, open positions, which season it is trading, and how much of its daily
 * allowance is left. Everything here is a database read, so it is cheap enough
 * to be polled and there is nothing to gain by hiding it behind a tighter limit
 * than the orders themselves.
 *
 * Positions are marked at the last known price and that is said plainly in the
 * response rather than left to be assumed. A mark is not a quote: it is what the
 * chart says, which is what an infinitely small trade would get, and the number a
 * real exit would fetch is smaller by this position's own impact. A program that
 * takes `valueLamports` for a sellable amount will consistently overestimate what
 * it is holding, and the field is named and documented so that it does not.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Older than this and a mark says more about the past than the present. */
const MARK_MAX_AGE_SECONDS = 900;

export async function GET(request: Request): Promise<Response> {
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
    const flood = await rateLimit(request, 'api-read');
    if (flood.response) return flood.response;
    return refuse(auth.status, auth.error);
  }
  if (!client) return refuse(503, 'The database is unavailable.');

  const throttled = await rateLimit(request, 'api-read', 1, auth.pubkey);
  if (throttled.response) return throttled.response;

  const now = Date.now();
  const { account, seasonId, ranked } = await activeSeason(client, auth.pubkey, now);

  /*
   * Read separately rather than carried on the active-season result, because
   * `activeSeason` answers "which account am I trading" and this answers "under
   * what conditions". A program needs the second to reason about a fill before
   * placing it, and inventing the fields would mean reporting free play's
   * conditions for a ranked season.
   */
  const current = ranked ? await currentRankedSeason(client, now) : null;
  const positions = await openPositions(client, account.id);

  const marks =
    positions.length === 0
      ? new Map<string, string>()
      : await lastPrices(
          client,
          positions.map((position) => position.mint),
          Math.floor(now / 1_000) - MARK_MAX_AGE_SECONDS,
        );

  const spent = await automatedTradesSince(client, account.id, now - DAY_MS);

  return Response.json({
    pubkey: auth.pubkey,
    season: {
      id: seasonId,
      ordinal: current?.ordinal ?? null,
      ranked,
      endsAt: current?.endsAt ?? null,
      status: current?.status ?? 'free_play',
    },
    /*
     * The conditions an order will be filled under, so a program can reason
     * about them rather than discover them by being refused. The latency is this
     * account's own, which is the number the fill actually waits out, and the
     * impact ceiling is the engine's: a leg that would move the price further
     * than this is refused at the quote and again at the fill.
     */
    conditions: {
      latencyMs: account.latencyMs,
      maxPriceImpactBps: DEFAULT_RULES.maxPriceImpactBps,
      defaultSlippageBps: DEFAULT_RULES.slippageBps,
    },
    balanceLamports: account.solBalance,
    positions: positions.map((position) => {
      const mark = marks.get(position.mint) ?? null;
      return {
        mint: position.mint,
        tokenAmount: position.tokenAmount,
        costBasisLamports: position.costBasis,
        realizedPnlLamports: position.realizedPnl,
        openedAt: position.openedAt,
        /*
         * Null rather than zero when nothing has priced it recently. A position
         * nobody can put a number on is not a position worth nothing, and the
         * difference between those two is a hundred percentage points of
         * somebody's return.
         */
        markPriceScaled: mark,
        valueLamports:
          mark === null ? null : ((BigInt(mark) * BigInt(position.tokenAmount)) / 10n ** 18n).toString(),
      };
    }),
    limits: {
      automatedOrdersToday: spent,
      dailyCap: DAILY_TRADE_CAP,
      ordersLeftToday: Math.max(0, DAILY_TRADE_CAP - spent),
    },
    note: 'valueLamports is a mark at the last known price, not a quote. A real exit fetches less, by this position’s own impact and the fee. Place the sell to find out what it actually gets.',
  });
}
