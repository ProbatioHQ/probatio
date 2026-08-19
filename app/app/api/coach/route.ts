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
  latestCoachReport,
  recordCoachReport,
} from '@probatio/db';
import { buildReport } from '@/lib/analytics';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
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
  const { account, seasonId, ranked } = await activeSeason(client, user.pubkey, now);

  return {
    accountId: account.id,
    pubkey: user.pubkey,
    // The tier follows the season the trader is actually in, so the
    // allowance cannot disagree with the account the report is about.
    tier: ranked ? 'ranked' : 'free',
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

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'paid');
  if (throttled.response) return throttled.response;

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
    // Counted in trades rather than in time, so the interface can show progress
    // toward the next one instead of a clock nobody is watching.
    tripsUntilNext: state.tripsUntilNext,
    unlocksAtTrips: state.unlocksAtTrips,
    reason:
      state.refusal === null
        ? null
        : explainRefusal(state.refusal, state.tripsUntilNext, MINIMUM_TRIPS),
  });
}

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'paid');
  if (throttled.response) return throttled.response;

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
            : explainRefusal(state.refusal!, state.tripsUntilNext, MINIMUM_TRIPS),
        tripsUntilNext: state.tripsUntilNext,
        unlocksAtTrips: state.unlocksAtTrips,
        report: previous ? serialize(previous) : null,
      },
      { status: 429 },
    );
  }

  /*
   * One retry when nothing survives checking.
   *
   * The reviewer drops any observation citing a figure the record does not
   * support, and a reply where every observation is dropped fails outright.
   * That is the right call for the reply in hand and the wrong outcome for the
   * trader, because the model is sampled and the next reply usually passes.
   * The allowance is only spent once a report is actually returned, so this
   * costs an API call rather than the trader's quota.
   */
  /*
   * Upstream failures that are worth trying again, and the ones that are not.
   *
   * A timeout, a network blip, a 429 or a 5xx are all "ask again in a moment".
   * A 401 or a 404 are a key or a model name being wrong, and retrying those
   * just makes the same mistake twice as fast while the trader waits.
   */
  const worthRetrying = (error: unknown): boolean => {
    if (!(error instanceof CoachError)) return false;
    if (error.code === 'timeout' || error.code === 'network' || error.code === 'empty') return true;
    const status = error.status ?? 0;
    return status === 429 || status >= 500;
  };

  let response;
  try {
    const model = coachModel();
    const options = { apiKey, ...(model ? { model } : {}) };

    try {
      response = await requestReport(brief, options);
    } catch (error) {
      if (!worthRetrying(error)) throw error;
      const detail = error instanceof CoachError ? `${error.code}/${error.status ?? '-'}` : '?';
      console.warn(`[coach] upstream failed (${detail}), retrying once`);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      response = await requestReport(brief, options);
    }

    if (!response.report) {
      console.warn('[coach] first reply rejected, retrying', response.problems);
      response = await requestReport(brief, options);
    }
  } catch (error) {
    const code = error instanceof CoachError ? error.code : 'network';
    const status = error instanceof CoachError ? error.status : undefined;
    // Logged with the specifics, because "could not be reached" on its own
    // cannot tell a wrong key from an overloaded upstream, and those need
    // opposite responses from whoever is reading the logs.
    console.error(
      `[coach] unreachable: code=${code} status=${status ?? '-'} ` +
        `message=${error instanceof Error ? error.message : String(error)}`,
    );
    return Response.json(
      {
        error: 'the coach could not be reached. Nothing was charged against your allowance.',
        code,
        ...(status === undefined ? {} : { status }),
      },
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
      {
        error: 'the coach produced something that did not check out. Try again.',
        // What the checks actually objected to. Rejecting a report is the right
        // outcome, but rejecting it silently leaves no way to tell a model
        // having an off moment from a guard that rejects everything it is
        // handed, and those need opposite responses.
        problems: response.problems,
        dropped: response.dropped,
      },
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
