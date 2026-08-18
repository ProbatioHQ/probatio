import {
  createRankedSeason,
  highestRankedOrdinal,
  seasonByOrdinal,
} from '@probatio/db';
import { encodeRuleset, rulesetFor, rulesetHashHex, scheduleFrom } from '@probatio/seasons';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Open the next ranked season, over HTTP.
 *
 * The same decision `scripts/open-season.mts` makes, reachable from somewhere
 * other than a shell. The database is a file on a mounted volume, so the script
 * can only be run by something already inside the container, and the host this
 * runs on offers no terminal — which left the one deliberate, irreversible
 * action in the system as the only one with nowhere to perform it.
 *
 * Guarded by a secret that has to be set for this route to exist at all. With
 * `ADMIN_SECRET` unset it answers as though it were not here, because a route
 * that can start a season people pay to enter should not be discoverable by
 * anybody who has not already been told about it.
 *
 * Deliberately not a job on a timer. A season is a thing people pay to enter;
 * starting one is a decision, and the first one especially should begin when
 * somebody meant it to.
 */

export async function POST(request: Request): Promise<Response> {
  const secret = process.env['ADMIN_SECRET'];
  // Unset, this route does not exist. Not 403: that would confirm it is here.
  if (!secret) return new Response('Not found', { status: 404 });

  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  if (request.headers.get('x-admin-secret') !== secret) {
    return new Response('Not found', { status: 404 });
  }

  let body: { dry?: boolean; at?: string; free?: boolean } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body means the ordinary case: the next season, starting when the
    // last one ends, at the published price.
  }

  const startsAt = body.at ? Date.parse(body.at) : null;
  if (startsAt !== null && Number.isNaN(startsAt)) {
    return Response.json({ error: 'at must be an ISO timestamp' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();
  const previousOrdinal = await highestRankedOrdinal(client);
  const ordinal = Math.max(1, previousOrdinal + 1);
  const previous = await seasonByOrdinal(client, previousOrdinal);
  const start = startsAt ?? previous?.endsAt ?? now;

  const base = rulesetFor(ordinal);
  const entryCost = body.free ? 0n : base.entryCost;
  // The hash has to describe the season that actually runs: hashing the standard
  // ruleset while opening a free one would publish a commitment to a price
  // nobody is charged, which is the one thing the hash exists to prevent.
  const rules = body.free ? { ...base, entryCost } : base;
  const schedule = scheduleFrom(start, rules.durationMs, rules.entryWindowMs);
  const hash = rulesetHashHex(rules);

  // Seasons may not overlap: a stretch covered by two is a stretch in which a
  // ranked trade counts toward both, or neither.
  if (previous?.endsAt != null && start < previous.endsAt) {
    return Response.json(
      {
        error: `season ${previousOrdinal} does not end until ${new Date(previous.endsAt).toISOString()}`,
      },
      { status: 409 },
    );
  }

  const plan = {
    ordinal,
    startsAt: new Date(schedule.startsAt).toISOString(),
    entryClosesAt: new Date(schedule.entryClosesAt).toISOString(),
    endsAt: new Date(schedule.endsAt).toISOString(),
    entryCostLamports: entryCost.toString(),
    entryCostSol: Number(entryCost) / 1e9,
    startingBalanceLamports: rules.startingBalance.toString(),
    rulesetBytes: encodeRuleset(rules).length,
    rulesetHash: hash,
  };

  if (body.dry) return Response.json({ dry: true, plan });

  await createRankedSeason(
    client,
    {
      ordinal,
      name: `Season ${ordinal}`,
      startsAt: schedule.startsAt,
      entryClosesAt: schedule.entryClosesAt,
      endsAt: schedule.endsAt,
      startingBalance: rules.startingBalance.toString(),
      entryCost: entryCost.toString(),
      houseBps: rules.houseBps,
      houseThreshold: rules.houseThreshold.toString(),
      latencyMs: rules.latencyMs,
      maxPriceImpactBps: rules.maxPriceImpactBps,
      engineVersion: rules.engineVersion,
      rulesetHash: hash,
    },
    now,
  );

  return Response.json({ opened: true, plan });
}
