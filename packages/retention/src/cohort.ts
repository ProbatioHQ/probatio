/**
 * Whether people come back.
 *
 * Computed from a record this product already has to keep — which wallet was
 * active on which day — rather than from a third-party analytics script.
 *
 * That is not only a privacy preference. A hosted analytics account is an
 * account: an email, a payment method, a company that knows who runs this.
 * Adding one would undo the anonymity the project is being built with, in
 * exchange for numbers that can be derived from the database in a few lines.
 *
 * So there is no script tag, no third party, and nothing collected beyond a
 * public wallet address and a date. No IP addresses, no user agents, no page
 * views, no device fingerprints.
 */

/** Days are UTC. A cohort boundary that moves with the reader is not a boundary. */
export const DAY_MS = 86_400_000;

export function dayNumber(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS);
}

export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export interface Activity {
  readonly pubkey: string;
  /** UTC day number. */
  readonly day: number;
  /** True if they placed at least one trade that day. */
  readonly traded: boolean;
}

export interface Cohort {
  /** The day this group first appeared. */
  readonly day: number;
  readonly size: number;
  /**
   * Fraction returning on each later day, in basis points, indexed by offset.
   * Index 0 is the joining day and is always 10000 by construction.
   */
  readonly returnBps: readonly (number | null)[];
  /** How many of them ever placed a trade. */
  readonly activated: number;
}

export interface RetentionOptions {
  /** How many days after joining to report. */
  readonly horizon?: number;
  /**
   * Today, as a day number. Offsets that have not happened yet report null
   * rather than zero — a cohort that joined yesterday has not failed to return
   * on day 7, it has not reached day 7.
   */
  readonly today: number;
}

const DEFAULT_HORIZON = 7;

export function cohorts(activity: readonly Activity[], options: RetentionOptions): Cohort[] {
  const horizon = options.horizon ?? DEFAULT_HORIZON;

  const daysByWallet = new Map<string, Set<number>>();
  const tradedBy = new Set<string>();

  for (const row of activity) {
    let days = daysByWallet.get(row.pubkey);
    if (!days) {
      days = new Set();
      daysByWallet.set(row.pubkey, days);
    }
    days.add(row.day);
    if (row.traded) tradedBy.add(row.pubkey);
  }

  const byCohort = new Map<number, string[]>();
  for (const [pubkey, days] of daysByWallet) {
    const first = Math.min(...days);
    const members = byCohort.get(first) ?? [];
    members.push(pubkey);
    byCohort.set(first, members);
  }

  return [...byCohort.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, members]) => {
      const returnBps: (number | null)[] = [];

      for (let offset = 0; offset <= horizon; offset += 1) {
        // The day has not happened yet for this cohort.
        if (day + offset > options.today) {
          returnBps.push(null);
          continue;
        }
        const returned = members.filter((pubkey) =>
          daysByWallet.get(pubkey)!.has(day + offset),
        ).length;
        returnBps.push(Math.round((returned * 10_000) / members.length));
      }

      return {
        day,
        size: members.length,
        returnBps,
        activated: members.filter((pubkey) => tradedBy.has(pubkey)).length,
      };
    });
}

export interface Summary {
  readonly wallets: number;
  readonly activated: number;
  readonly activationBps: number | null;
  /** Averaged over cohorts old enough to have reached the day. Null if none have. */
  readonly d1Bps: number | null;
  readonly d2Bps: number | null;
  readonly d7Bps: number | null;
  /** Cohorts that have reached day 7. The number the d7 figure rests on. */
  readonly maturedCohorts: number;
}

/**
 * The headline numbers.
 *
 * Averaged over cohorts weighted by size, and only over cohorts old enough to
 * have reached the day in question. Including a cohort that joined yesterday in
 * a day-7 figure drags it toward zero and calls it churn, when the truth is
 * that nobody has had the chance to come back yet.
 */
export function summarize(list: readonly Cohort[], horizonDay: number): Summary {
  const wallets = list.reduce((sum, cohort) => sum + cohort.size, 0);
  const activated = list.reduce((sum, cohort) => sum + cohort.activated, 0);

  const average = (offset: number): number | null => {
    const mature = list.filter((cohort) => cohort.returnBps[offset] !== null && cohort.returnBps[offset] !== undefined);
    if (mature.length === 0) return null;
    const people = mature.reduce((sum, cohort) => sum + cohort.size, 0);
    if (people === 0) return null;
    const returned = mature.reduce(
      (sum, cohort) => sum + (cohort.returnBps[offset]! * cohort.size) / 10_000,
      0,
    );
    return Math.round((returned * 10_000) / people);
  };

  return {
    wallets,
    activated,
    activationBps: wallets === 0 ? null : Math.round((activated * 10_000) / wallets),
    d1Bps: average(1),
    d2Bps: average(2),
    d7Bps: average(7),
    maturedCohorts: list.filter((cohort) => cohort.day + 7 <= horizonDay).length,
  };
}
