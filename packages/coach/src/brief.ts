import type { Drawdown, ExcursionSummary, Metrics, TimeOfDay } from '@probatio/analytics';

/**
 * What the coach is allowed to know.
 *
 * A flat set of named facts, each already computed and already true. The model
 * is given these and nothing else — no raw log, no chance to do arithmetic of
 * its own — because a coach that produces its own numbers is a coach that
 * eventually produces a wrong one, on a page whose entire claim is that its
 * numbers can be checked.
 *
 * Every fact is optional. A trader with no losses has no average loss, and a
 * brief that filled that in with zero would have the coach explain a loss that
 * never happened.
 */

export type FactKey =
  | 'trips'
  | 'winRateBps'
  | 'netPnl'
  | 'expectancy'
  | 'profitFactorBps'
  | 'winLossMultipleBps'
  | 'averageWin'
  | 'averageLoss'
  | 'largestLoss'
  | 'medianHoldMs'
  | 'winnerHoldMs'
  | 'loserHoldMs'
  | 'sizeConsistencyBps'
  | 'averageSize'
  | 'maxDrawdownBps'
  | 'longestLosingStreak'
  | 'entryEfficiencyBps'
  | 'exitEfficiencyBps'
  | 'averageMfeBps'
  | 'averageMaeBps'
  | 'gaveBackWinners'
  | 'feesPaid'
  | 'bestHourUtc'
  | 'worstHourUtc';

export interface Fact {
  readonly key: FactKey;
  /** Plain English, for the model to read. */
  readonly label: string;
  /** Already formatted. The model never sees a raw bigint. */
  readonly value: string;
}

export interface Brief {
  readonly facts: readonly Fact[];
  readonly tradeCount: number;
  /**
   * True when there is enough history for advice to mean anything. Below this
   * the honest output is "trade more", and saying anything else would dress
   * noise up as a pattern.
   */
  readonly sufficient: boolean;
  readonly minimumTrips: number;
}

/** Fewer closed round trips than this and there is nothing to coach. */
export const MINIMUM_TRIPS = 5;

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Lamports as SOL, to three places, without floating point. */
export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = ((absolute % LAMPORTS_PER_SOL) * 1_000n) / LAMPORTS_PER_SOL;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(3, '0')} SOL`;
}

/** Basis points as a percentage, to one place. */
export function formatBps(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const absolute = Math.abs(bps);
  return `${sign}${Math.floor(absolute / 100)}.${Math.round(absolute % 100)
    .toString()
    .padStart(2, '0')
    .slice(0, 1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export interface BriefInput {
  readonly metrics: Metrics;
  readonly drawdown: Drawdown;
  readonly timeOfDay: TimeOfDay;
  readonly excursions: ExcursionSummary;
}

export function buildBrief(input: BriefInput, minimumTrips = MINIMUM_TRIPS): Brief {
  const { metrics, drawdown, timeOfDay, excursions } = input;
  const facts: Fact[] = [];

  const add = (key: FactKey, label: string, value: string | null): void => {
    if (value !== null) facts.push({ key, label, value });
  };

  add('trips', 'Closed round trips', String(metrics.trips));
  add(
    'winRateBps',
    'Win rate',
    metrics.winRateBps === null
      ? null
      : `${formatBps(metrics.winRateBps)} (${metrics.wins} of ${metrics.trips})`,
  );
  add('netPnl', 'Net profit and loss', formatSol(metrics.netPnl));
  add('expectancy', 'Average result per trip', metrics.expectancy === null ? null : formatSol(metrics.expectancy));
  add(
    'profitFactorBps',
    'Profit factor (gross won over gross lost)',
    metrics.profitFactorBps === null ? null : formatBps(metrics.profitFactorBps),
  );
  add(
    'winLossMultipleBps',
    'Average win as a share of average loss',
    metrics.winLossMultipleBps === null ? null : formatBps(metrics.winLossMultipleBps),
  );
  add('averageWin', 'Average win', metrics.winSizes.average === null ? null : formatSol(metrics.winSizes.average));
  add('averageLoss', 'Average loss', metrics.lossSizes.average === null ? null : formatSol(metrics.lossSizes.average));
  add('largestLoss', 'Largest single loss', metrics.lossSizes.largest === null ? null : formatSol(metrics.lossSizes.largest));

  add('medianHoldMs', 'Median hold', metrics.holdMs.median === null ? null : formatDuration(metrics.holdMs.median));
  add('winnerHoldMs', 'Median hold on winners', metrics.winnerHoldMs.median === null ? null : formatDuration(metrics.winnerHoldMs.median));
  add('loserHoldMs', 'Median hold on losers', metrics.loserHoldMs.median === null ? null : formatDuration(metrics.loserHoldMs.median));

  add('averageSize', 'Average position size', metrics.positionSizes.average === null ? null : formatSol(metrics.positionSizes.average));
  add(
    'sizeConsistencyBps',
    'Position size variation (0% means every trade the same size)',
    metrics.sizeConsistencyBps === null ? null : formatBps(metrics.sizeConsistencyBps),
  );

  // Gated on there being trips at all. A trader with no closed trades has a
  // drawdown of zero and a losing streak of zero, both true and both an
  // invitation to praise risk management that was never demonstrated.
  if (metrics.trips > 0) {
    add(
      'maxDrawdownBps',
      'Deepest fall from a peak',
      drawdown.maxDrawdownBps === null ? null : formatBps(drawdown.maxDrawdownBps),
    );
    add('longestLosingStreak', 'Longest losing streak', String(drawdown.longestLosingStreak));
  }

  add(
    'entryEfficiencyBps',
    'Entry timing (100% would be buying the exact low of the hold)',
    excursions.averageEntryEfficiencyBps === null ? null : formatBps(excursions.averageEntryEfficiencyBps),
  );
  add(
    'exitEfficiencyBps',
    'Exit timing (100% would be selling the exact high of the hold)',
    excursions.averageExitEfficiencyBps === null ? null : formatBps(excursions.averageExitEfficiencyBps),
  );
  add('averageMfeBps', 'Average best unrealized gain reached', excursions.averageMfeBps === null ? null : formatBps(excursions.averageMfeBps));
  add('averageMaeBps', 'Average worst unrealized loss endured', excursions.averageMaeBps === null ? null : formatBps(excursions.averageMaeBps));
  add(
    'gaveBackWinners',
    `Trips that were up over ${formatBps(excursions.gaveBackThresholdBps)} and still closed red`,
    excursions.count === 0 ? null : String(excursions.gaveBackWinners),
  );

  add('feesPaid', 'Total fees paid', formatSol(metrics.feesPaid));
  add('bestHourUtc', 'Most profitable hour (UTC)', timeOfDay.bestHour === null ? null : `${timeOfDay.bestHour.index}:00`);
  add('worstHourUtc', 'Least profitable hour (UTC)', timeOfDay.worstHour === null ? null : `${timeOfDay.worstHour.index}:00`);

  return {
    facts,
    tradeCount: metrics.trips,
    sufficient: metrics.trips >= minimumTrips,
    minimumTrips,
  };
}
