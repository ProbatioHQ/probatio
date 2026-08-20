import { copyableSwaps } from '@probatio/db';
import { backtestCopy } from '@probatio/sim';
import { PUMPSWAP_DEFAULT_FEES } from '@probatio/pools';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';

/**
 * What copying a real wallet would actually have made you.
 *
 * The whole argument of this site applied to somebody else's record: not "this
 * wallet is up 340%", which is true and useless, but "copying it at your size,
 * filling after them the way you actually would have, would have made you 71%,
 * and here is where the rest went".
 *
 * Runs on history already stored, so it costs a query and no chain reads.
 */

export const dynamic = 'force-dynamic';

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const WINDOW_DAYS = 30;
/** Ten SOL, the same balance a new trader is given, so the number is relatable. */
const DEFAULT_BALANCE = 10_000_000_000n;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const trader = url.searchParams.get('trader') ?? '';
  if (!WALLET.test(trader)) {
    return Response.json({ error: 'not a wallet address' }, { status: 400 });
  }

  const balanceParam = url.searchParams.get('balance');
  let startingBalance = DEFAULT_BALANCE;
  if (balanceParam !== null) {
    const parsed = Number(balanceParam);
    // Bounded, because the answer is meaningless below dust and this is priced
    // through the real engine at whatever size it is handed.
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000) {
      return Response.json({ error: 'balance must be between 0 and 10000 SOL' }, { status: 400 });
    }
    startingBalance = BigInt(Math.round(parsed * 1e9));
  }

  const since = Math.floor(Date.now() / 1_000) - WINDOW_DAYS * 24 * 60 * 60;
  const swaps = await copyableSwaps(await db(), trader, since);

  if (swaps.length === 0) {
    return Response.json({
      trader,
      windowDays: WINDOW_DAYS,
      // Nothing priceable is not the same as a flat result, and the two must
      // not render the same way.
      available: false,
      reason: 'no swaps with pool reserves recorded for this wallet in the window',
    });
  }

  const result = backtestCopy(swaps, {
    startingBalance,
    fees: PUMPSWAP_DEFAULT_FEES,
  });

  return Response.json({
    trader,
    windowDays: WINDOW_DAYS,
    available: true,
    startingBalance: result.startingBalance.toString(),
    endingEquity: result.endingEquity.toString(),
    returnBps: result.returnBps,
    leaderReturnBps: result.leaderReturnBps,
    // The same figures the row above reports, so the two cannot disagree.
    leaderRealized: result.leaderRealized.toString(),
    copierRealized: result.copierRealized.toString(),
    latencyCost: result.latencyCost.toString(),
    copied: result.copied,
    skipped: result.skipped,
    // The last few legs, so somebody can see the gap on individual trades
    // rather than being asked to believe a single summary figure.
    legs: result.legs.slice(-12).map((leg) => ({
      mint: leg.mint,
      isBuy: leg.isBuy,
      at: leg.at,
      sol: leg.sol.toString(),
      leaderPrice: leg.leaderPrice.toString(),
      copierPrice: leg.copierPrice.toString(),
    })),
  });
}
