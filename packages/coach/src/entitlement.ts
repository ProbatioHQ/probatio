/**
 * Who may ask for a report, and how often.
 *
 * Counted in closed trades, not in time. A report is a reading of a record, so
 * what makes a new one worth asking for is the record having changed enough to
 * read differently, and five closed trades is enough to move a win rate or a
 * hold time. A clock says nothing about that: a week of not trading produces
 * the same report as the one before it, and an afternoon of twenty trades
 * produces a genuinely different record that a weekly limit would sit on.
 *
 * Each report covers everything up to the moment it was asked for, so the
 * second one reads ten trades rather than the five since the first, and the
 * ones before it are kept as they were.
 *
 * Pure, so the rule can be tested without a clock or a database, and so the
 * same function answers "may I?" and "how far off am I?" rather than two
 * versions of the policy drifting apart.
 */

export type Tier = 'free' | 'ranked';

/** Closed trades between one report and the next. */
export const TRIPS_PER_REPORT = 5;

export type Refusal = 'not_enough_trades' | 'need_more_trades';

export interface EntitlementInput {
  readonly tier: Tier;
  readonly now: number;
  /** Null if they have never had one. */
  readonly lastReportAt: number | null;
  /** Closed round trips as of the last report. */
  readonly tripsAtLastReport: number;
  readonly tripsNow: number;
  readonly minimumTrips: number;
}

export interface Entitlement {
  readonly allowed: boolean;
  readonly refusal: Refusal | null;
  /** How many more closed trades are needed. Zero when one may be asked for. */
  readonly tripsUntilNext: number;
  /** The count at which the next report unlocks, for showing progress against. */
  readonly unlocksAtTrips: number;
}

export function entitlement(input: EntitlementInput): Entitlement {
  // The first report waits for a record worth reading at all.
  if (input.lastReportAt === null) {
    if (input.tripsNow < input.minimumTrips) {
      return {
        allowed: false,
        refusal: 'not_enough_trades',
        tripsUntilNext: input.minimumTrips - input.tripsNow,
        unlocksAtTrips: input.minimumTrips,
      };
    }
    return { allowed: true, refusal: null, tripsUntilNext: 0, unlocksAtTrips: input.minimumTrips };
  }

  // Every one after it waits for another five to close.
  const unlocksAtTrips = input.tripsAtLastReport + TRIPS_PER_REPORT;
  if (input.tripsNow < unlocksAtTrips) {
    return {
      allowed: false,
      refusal: 'need_more_trades',
      tripsUntilNext: unlocksAtTrips - input.tripsNow,
      unlocksAtTrips,
    };
  }

  return { allowed: true, refusal: null, tripsUntilNext: 0, unlocksAtTrips };
}

export function explainRefusal(refusal: Refusal, remaining: number, minimumTrips: number): string {
  const trades = (n: number): string => `${n} ${n === 1 ? 'trade' : 'trades'}`;
  switch (refusal) {
    case 'not_enough_trades':
      return `Close ${trades(minimumTrips)} and there will be a pattern worth reviewing. ` +
        `${trades(remaining)} to go.`;
    case 'need_more_trades':
      return `Close ${trades(remaining)} more and a new report can be written, covering ` +
        `everything up to that point.`;
  }
}
