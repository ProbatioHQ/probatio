
import { buildReport } from '@/lib/analytics';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';

/**
 * Everything the trade log says about the trader.
 *
 * Derived on every request rather than stored. These numbers are a function of
 * the log and nothing else, so caching them would only create a second version
 * that can be wrong — and this is the page a trader will point at when they
 * claim they are good.
 *
 * bigints are serialized as strings, the same discipline every amount in this
 * project follows.
 */

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) {
    return Response.json({ error: 'sign in to see your stats' }, { status: 401 });
  }

  const client = await db();
  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, user.pubkey, now);

  const report = await buildReport(client, account.id, BigInt(account.startingBalance));
  const { metrics, drawdown, timeOfDay, excursions } = report;

  const amount = (value: bigint | null): string | null => (value === null ? null : value.toString());

  return Response.json({
    trips: metrics.trips,
    wins: metrics.wins,
    losses: metrics.losses,
    scratches: metrics.scratches,
    winRateBps: metrics.winRateBps,

    netPnl: metrics.netPnl.toString(),
    grossProfit: metrics.grossProfit.toString(),
    grossLoss: metrics.grossLoss.toString(),
    feesPaid: metrics.feesPaid.toString(),
    expectancy: amount(metrics.expectancy),
    profitFactorBps: metrics.profitFactorBps,
    winLossMultipleBps: metrics.winLossMultipleBps,

    averageWin: amount(metrics.winSizes.average),
    averageLoss: amount(metrics.lossSizes.average),
    largestWin: amount(metrics.winSizes.largest),
    largestLoss: amount(metrics.lossSizes.largest),
    averageSize: amount(metrics.positionSizes.average),
    sizeConsistencyBps: metrics.sizeConsistencyBps,

    holdMs: metrics.holdMs,
    winnerHoldMs: metrics.winnerHoldMs,
    loserHoldMs: metrics.loserHoldMs,

    maxDrawdown: drawdown.maxDrawdown.toString(),
    maxDrawdownBps: drawdown.maxDrawdownBps,
    longestLosingStreak: drawdown.longestLosingStreak,
    longestWinningStreak: drawdown.longestWinningStreak,
    equityCurve: drawdown.curve.map((point) => ({
      at: point.at,
      equity: point.equity.toString(),
    })),

    bestHourUtc: timeOfDay.bestHour?.index ?? null,
    worstHourUtc: timeOfDay.worstHour?.index ?? null,
    hours: timeOfDay.hours.map((bucket) => ({
      hour: bucket.index,
      trips: bucket.trips,
      realized: bucket.realized.toString(),
      winRateBps: bucket.winRateBps,
    })),

    entryEfficiencyBps: excursions.averageEntryEfficiencyBps,
    exitEfficiencyBps: excursions.averageExitEfficiencyBps,
    averageMfeBps: excursions.averageMfeBps,
    averageMaeBps: excursions.averageMaeBps,
    gaveBackWinners: excursions.gaveBackWinners,
    excursionsScored: excursions.count,

    openPositions: report.openTrips.length,
    unusableTrades: report.skipped,
  });
}
