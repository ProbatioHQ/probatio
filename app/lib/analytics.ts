import 'server-only';
import {
  computeDrawdown,
  computeExcursion,
  computeMetrics,
  computeTimeOfDay,
  reconstruct,
  summarizeExcursions,
  type Drawdown,
  type ExcursionSummary,
  type LoggedTrade,
  type Metrics,
  type Reconstruction,
  type TimeOfDay,
} from '@probatio/analytics';
import { allTrades, priceRange, type TradeRow } from '@probatio/db';
import type { Client } from '@libsql/client';

/**
 * The trader's own numbers, built from their trade log.
 *
 * The engine is pure, so everything network- or database-shaped lives here:
 * loading the log, and looking up the price range each position lived through.
 */

/** The timeframe the excursion ranges are read at. */
const RANGE_TIMEFRAME = '1m';

export interface Report {
  readonly metrics: Metrics;
  readonly drawdown: Drawdown;
  readonly timeOfDay: TimeOfDay;
  readonly excursions: ExcursionSummary;
  readonly openTrips: Reconstruction['open'];
  /**
   * Fills the replay could not use. Zero in normal operation; anything else is
   * worth knowing about rather than quietly averaging over.
   */
  readonly skipped: number;
}

export function toLoggedTrade(row: TradeRow): LoggedTrade {
  return {
    mint: row.mint,
    side: row.side,
    solAmount: BigInt(row.solAmount),
    tokenAmount: BigInt(row.tokenAmount),
    feeLamports: BigInt(row.fee),
    priceImpactBps: row.priceImpactBps,
    at: row.createdAt,
  };
}

export async function buildReport(
  client: Client,
  accountId: number,
  startingBalance: bigint,
): Promise<Report> {
  const rows = await allTrades(client, accountId);
  const { closed, open, skipped } = reconstruct(rows.map(toLoggedTrade));

  // One range lookup per closed trip. A trip whose window has no candles is
  // left out of the excursion summary rather than scored against a guess.
  const excursions = (
    await Promise.all(
      closed.map(async (trip) => {
        const range = await priceRange(
          client,
          trip.mint,
          RANGE_TIMEFRAME,
          Math.floor(trip.openedAt / 1_000),
          Math.ceil(trip.closedAt / 1_000),
        );
        return range === null ? null : computeExcursion(trip, range);
      }),
    )
  ).filter((entry) => entry !== null);

  return {
    metrics: computeMetrics(closed),
    drawdown: computeDrawdown(closed, startingBalance),
    timeOfDay: computeTimeOfDay(closed),
    excursions: summarizeExcursions(excursions),
    openTrips: open,
    skipped: skipped.length,
  };
}
