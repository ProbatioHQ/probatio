/**
 * Who may ask for a report, and how often.
 *
 * Free gets one a week. Ranked gets one per session. Both are gated on the
 * record having actually changed, which is not a billing rule — running the
 * same numbers twice produces the same advice and charges for it.
 *
 * Pure, so the rule can be tested without a clock or a database, and so the
 * same function answers "may I?" and "when may I?" rather than two versions of
 * the policy drifting apart.
 */

export type Tier = 'free' | 'ranked';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
/** Long enough that a report covers a sitting rather than a single trade. */
export const RANKED_COOLDOWN_MS = 60 * 60 * 1_000;

export type Refusal = 'not_enough_trades' | 'nothing_new' | 'cooldown';

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
  /** When they could next ask, if waiting is what is needed. */
  readonly nextAllowedAt: number | null;
}

export function cooldownFor(tier: Tier): number {
  return tier === 'ranked' ? RANKED_COOLDOWN_MS : WEEK_MS;
}

export function entitlement(input: EntitlementInput): Entitlement {
  if (input.tripsNow < input.minimumTrips) {
    return { allowed: false, refusal: 'not_enough_trades', nextAllowedAt: null };
  }

  // The first report is never gated on anything but having traded.
  if (input.lastReportAt === null) {
    return { allowed: true, refusal: null, nextAllowedAt: null };
  }

  if (input.tripsNow <= input.tripsAtLastReport) {
    return { allowed: false, refusal: 'nothing_new', nextAllowedAt: null };
  }

  const ready = input.lastReportAt + cooldownFor(input.tier);
  if (input.now < ready) {
    return { allowed: false, refusal: 'cooldown', nextAllowedAt: ready };
  }

  return { allowed: true, refusal: null, nextAllowedAt: null };
}

export function explainRefusal(refusal: Refusal, tier: Tier, minimumTrips: number): string {
  switch (refusal) {
    case 'not_enough_trades':
      return `Close at least ${minimumTrips} trades and there will be a pattern worth reviewing.`;
    case 'nothing_new':
      return 'Nothing has changed since the last report. Trade, then come back.';
    case 'cooldown':
      return tier === 'ranked'
        ? 'Your last report is still recent. A session needs to be a session.'
        : 'Free accounts get one report a week. Ranked gets one per session.';
  }
}
