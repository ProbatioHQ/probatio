import {
  StrategyError,
  currentRankedSeason,
  ensureAccount,
  hasEntered,
  automatedTradesSince,
  openPositions,
  recordStrategyEvent,
  saveStrategy,
  startStrategy,
  stopStrategy,
  strategyEvents,
  strategyFor,
} from '@probatio/db';
import {
  DAILY_TRADE_CAP,
  RULES_VERSION,
  StrategyRulesError,
  parseStrategyRules,
  serializeStrategyRules,
} from '@probatio/sim';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * The strategy this account runs, and whether it is running.
 *
 * A strategy trades the account its owner already entered the season with. It is
 * not a second entrant, it pays no second entry, and it reaches the engine by the
 * same path a click does. What it changes is who decides when to trade.
 */

const MAX_NAME = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  const client = await db();
  const now = Date.now();
  const season = await currentRankedSeason(client, now);
  if (!season) {
    return Response.json({ strategy: null, season: null, events: [], limits: null });
  }

  const strategy = await strategyFor(client, user.pubkey, season.id);

  /*
   * Only for somebody who actually entered.
   *
   * `ensureAccount` creates the row it is asked about, so calling it for a
   * visitor who has not entered would quietly mint them a ranked account as a
   * side effect of loading a page. Reading is not entering.
   */
  const entered = await hasEntered(client, season.id, user.pubkey);
  const account = entered ? await ensureAccount(client, season.id, user.pubkey, now) : null;
  const spent = account ? await automatedTradesSince(client, account.id, now - DAY_MS) : 0;

  return Response.json({
    season: { id: season.id, ordinal: season.ordinal, status: season.status, endsAt: season.endsAt },
    strategy:
      strategy === null
        ? null
        : {
            id: strategy.id,
            name: strategy.name,
            rules: JSON.parse(strategy.rules) as unknown,
            rulesVersion: strategy.rulesVersion,
            status: strategy.status,
            stoppedReason: strategy.stoppedReason,
            startedAt: strategy.startedAt,
            stoppedAt: strategy.stoppedAt,
          },
    // What it did, and what it declined to do. A strategy that trades nothing is
    // otherwise indistinguishable from one that is broken.
    events: strategy === null ? [] : await strategyEvents(client, strategy.id, 40),
    entered,
    openPositions: account ? (await openPositions(client, account.id)).length : 0,
    limits: { automatedOrdersToday: spent, dailyCap: DAILY_TRADE_CAP },
  });
}

/** Save the rules. Always a draft: saving is not starting. */
export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const name = String(source['name'] ?? 'my strategy').trim().slice(0, MAX_NAME) || 'my strategy';

  let rules;
  try {
    rules = parseStrategyRules(source['rules']);
  } catch (error) {
    // The message is the point. A rule set is refused with the reason a person
    // can act on, not with "invalid".
    if (error instanceof StrategyRulesError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const client = await db();
  const now = Date.now();
  const season = await currentRankedSeason(client, now);
  if (!season) return Response.json({ error: 'there is no season to run in yet' }, { status: 409 });

  const existing = await strategyFor(client, user.pubkey, season.id);
  if (existing?.status === 'running') {
    return Response.json(
      { error: 'stop the running strategy before changing its rules' },
      { status: 409 },
    );
  }

  const saved = await saveStrategy(client, {
    userPubkey: user.pubkey,
    seasonId: season.id,
    name,
    rules: serializeStrategyRules(rules),
    rulesVersion: RULES_VERSION,
    now,
  });

  return Response.json({ id: saved.id, status: saved.status });
}

/** Start it or stop it. */
export async function PATCH(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const action = String((body as { action?: unknown }).action ?? '');
  if (action !== 'start' && action !== 'stop') {
    return Response.json({ error: 'action must be start or stop' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();
  const season = await currentRankedSeason(client, now);
  if (!season) return Response.json({ error: 'there is no season to run in' }, { status: 409 });

  const strategy = await strategyFor(client, user.pubkey, season.id);
  if (!strategy) return Response.json({ error: 'save a strategy first' }, { status: 404 });

  if (action === 'stop') {
    await stopStrategy(client, strategy.id, 'you stopped it', now);
    await recordStrategyEvent(client, strategy.id, {
      at: now,
      kind: 'stopped',
      mint: null,
      /*
       * Said plainly, because it is the thing people assume wrongly. Stopping
       * ends the entering. Whatever it is already holding stays held, and stays
       * yours to sell, which is the only behaviour that does not dump somebody's
       * positions into a market on their behalf without being asked.
       */
      detail: 'you stopped it. Anything it was holding is still open and still yours to close.',
    });
    return Response.json({ status: 'stopped' });
  }

  if (season.status !== 'running') {
    return Response.json(
      { error: `the season is ${season.status}, so there is nothing to trade yet` },
      { status: 409 },
    );
  }

  /*
   * Refused here as well as in the runner, and both are wanted.
   *
   * The runner's check is the one that closes the hole; this one is the one that
   * says so to somebody's face. Without it, pressing run appears to work and the
   * strategy stops itself seconds later, which reads as a broken feature rather
   * than as an unpaid entry.
   */
  if (!(await hasEntered(client, season.id, user.pubkey))) {
    return Response.json(
      {
        error:
          'enter the season first. A strategy trades the account you entered with, so it needs an entry the same as trading by hand does.',
      },
      { status: 409 },
    );
  }

  try {
    await startStrategy(client, strategy.id, now);
  } catch (error) {
    if (error instanceof StrategyError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  await recordStrategyEvent(client, strategy.id, {
    at: now,
    kind: 'started',
    mint: null,
    detail: 'running. It trades your account, on the same clock and the same fills as a click.',
  });

  return Response.json({ status: 'running' });
}
