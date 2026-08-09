import {
  buildBrief,
  entitlement,
  explainRefusal,
  insufficientHistoryMessage,
  requestReport,
  CoachError,
  MINIMUM_TRIPS,
  type Tier,
} from '@probatio/coach';
import {
  ensureAccount,
  ensureFreePlaySeason,
  isRankedSeason,
  latestCoachReport,
  recordCoachReport,
} from '@probatio/db';
import { buildReport } from '@/lib/analytics';
import { db } from '@/lib/db';
import { coachApiKey, coachModel } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * The coach.
 *
 * GET returns the last report and whether a new one is available. POST spends
 * the call.
 *
 * The order of operations matters and is deliberate. Entitlement is checked
 * before the model is called, so a refused request costs nothing; the result is
 * then written under a unique constraint on (account, trade count), so two
 * requests that both passed the check cannot both be stored. The second one
 * gets the first one's report, which is the same report it would have paid to
 * produce.
 */

interface Context {
  readonly accountId: number;
  readonly pubkey: string;
  readonly tier: Tier;
  /**
   * Carried through because drawdown is a share of peak equity. Measuring it
   * from zero would make every trader's first loss a 100% drawdown.
   */
  readonly startingBalance: bigint;
  readonly seasonId: number;
}

async function context(): Promise<Context | null> {
  const user = await currentUser();
  if (!user) return null;

  const client = await db();
  const now = Date.now();
  const seasonId = await ensureFreePlaySeason(client, now);
  const account = await ensureAccount(client, seasonId, user.pubkey, now);

  return {
    accountId: account.id,
    pubkey: user.pubkey,
    tier: (await isRankedSeason(client, seasonId)) ? 'ranked' : 'free',
    startingBalance: BigInt(account.startingBalance),
    seasonId,
  };
}

function serialize(report: {
  headline: string;
  focus: string;
  observations: readonly { metric: string; text: string }[];
  createdAt: number;
  tripsAtReport: number;
}) {
  return {
    headline: report.headline,
    focus: report.focus === '' ? null : report.focus,
    observations: report.observations,
    createdAt: report.createdAt,
    tripsAtReport: report.tripsAtReport,
  };
}

export async function GET(): Promise<Response> {
  const ctx = await context();
  if (!ctx) return Response.json({ error: 'sign in to see your coach report' }, { status: 401 });

  const client = await db();
  const analytics = await buildReport(client, ctx.accountId, ctx.startingBalance);
  const previous = await latestCoachReport(client, ctx.accountId);
  const trips = analytics.metrics.trips;

  const state = entitlement({
    tier: ctx.tier,
    now: Date.now(),
    lastReportAt: previous?.createdAt ?? null,
    tripsAtLastReport: previous?.tripsAtReport ?? 0,
    tripsNow: trips,
    minimumTrips: MINIMUM_TRIPS,
  });

  return Response.json({
    tier: ctx.tier,
    trips,
    minimumTrips: MINIMUM_TRIPS,
    report: previous ? serialize(previous) : null,
    available: state.allowed,
    nextAvailableAt: state.nextAllowedAt,
    reason:
      state.refusal === null ? null : explainRefusal(state.refusal, ctx.tier, MINIMUM_TRIPS),
  });
}

export async function POST(): Promise<Response> {
  const ctx = await context();
  if (!ctx) return Response.json({ error: 'sign in to get a coach report' }, { status: 401 });

  const apiKey = coachApiKey();
  if (!apiKey) {
    return Response.json({ error: 'the coach is not configured on this server' }, { status: 503 });
  }

  const client = await db();
  const analytics = await buildReport(client, ctx.accountId, ctx.startingBalance);
  const previous = await latestCoachReport(client, ctx.accountId);
  const trips = analytics.metrics.trips;

  const state = entitlement({
    tier: ctx.tier,
    now: Date.now(),
    lastReportAt: previous?.createdAt ?? null,
    tripsAtLastReport: previous?.tripsAtReport ?? 0,
    tripsNow: trips,
    minimumTrips: MINIMUM_TRIPS,
  });

  const brief = buildBrief(analytics);

  if (!state.allowed) {
    // Refused before the call, so nothing is spent. The message is the honest
    // one for the case rather than a generic denial.
    return Response.json(
      {
        error:
          state.refusal === 'not_enough_trades'
            ? insufficientHistoryMessage(brief)
            : explainRefusal(state.refusal!, ctx.tier, MINIMUM_TRIPS),
        nextAvailableAt: state.nextAllowedAt,
        report: previous ? serialize(previous) : null,
      },
      { status: 429 },
    );
  }

  let response;
  try {
    const model = coachModel();
    response = await requestReport(brief, { apiKey, ...(model ? { model } : {}) });
  } catch (error) {
    const code = error instanceof CoachError ? error.code : 'network';
    return Response.json(
      { error: 'the coach could not be reached. Nothing was charged against your allowance.', code },
      { status: 502 },
    );
  }

  if (!response.report) {
    // The call happened and the answer did not survive checking. Failing here
    // is the correct outcome: a report containing a figure this system did not
    // compute is worse than no report on a page that claims its numbers can be
    // verified.
    console.warn('[coach] response rejected', response.problems);
    return Response.json(
      { error: 'the coach produced something that did not check out. Try again.' },
      { status: 502 },
    );
  }

  const stored = await recordCoachReport(
    client,
    {
      accountId: ctx.accountId,
      seasonId: ctx.seasonId,
      userPubkey: ctx.pubkey,
      kind: 'session',
      // The facts the model was shown, stored beside what it wrote. Without
      // them the wording could only ever be checked against whatever the
      // numbers say later, which is not the same claim.
      facts: brief.facts.map((fact) => ({ ...fact })),
      // From the last report, or from the first trade if this is the first
      // one. The period is what the advice actually covers.
      periodStart: previous?.createdAt ?? analytics.drawdown.curve[0]?.at ?? Date.now(),
      periodEnd: Date.now(),
      tripsAtReport: trips,
      headline: response.report.headline,
      focus: response.report.focus,
      observations: [...response.report.observations],
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      dropped: response.dropped,
    },
    Date.now(),
  );

  // Null means another request stored one first. Theirs is about the same
  // trades and says the same thing, so it is returned rather than an error.
  const result = stored ?? (await latestCoachReport(client, ctx.accountId));
  if (!result) {
    return Response.json({ error: 'the report could not be saved' }, { status: 500 });
  }

  return Response.json({ tier: ctx.tier, trips, report: serialize(result) });
}
