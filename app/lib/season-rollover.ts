import 'server-only';
import { createRankedSeason, highestRankedOrdinal, seasonByOrdinal } from '@probatio/db';
import { encodeRuleset, rulesetFor, rulesetHashHex } from '@probatio/seasons';
import { db } from './db';

/**
 * Opening the next season without anybody being there.
 *
 * A season ends on a Friday morning and the next one opens that Friday evening,
 * every week, and none of that should require somebody to be awake and at a
 * terminal. The first season is still opened deliberately, because starting to
 * take money is a decision; every season after it follows from the one before.
 *
 * The cycle, in the operator's own hours:
 *
 *   Friday 20:00   the season opens and trading begins
 *   Monday 00:00   entries close; everybody already in keeps trading
 *   Friday 10:00   the season ends and is paid out
 *   Friday 20:00   the next one opens
 *
 * Ten hours between a season ending and the next beginning, so results settle
 * and get paid before anybody is asked to enter again.
 */

/**
 * The hours are the operator's, not the server's.
 *
 * A season announced for ten on a Friday has to fall on ten on a Friday where
 * the people entering it live, in summer and in winter alike. Doing this in UTC
 * would put it an hour out for half the year, on the half nobody is expecting.
 */
const ZONE = 'Europe/Stockholm';

const OPENS = { weekday: 'Fri', hour: 20, minute: 0 } as const;
const ENTRIES_CLOSE = { weekday: 'Mon', hour: 0, minute: 0 } as const;
const ENDS = { weekday: 'Fri', hour: 10, minute: 0 } as const;

interface Moment {
  readonly weekday: string;
  readonly hour: number;
  readonly minute: number;
}

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** What a given instant reads as on a clock in the zone. */
function inZone(at: number): { weekday: string; hour: number; minute: number } {
  const found = parts.formatToParts(new Date(at));
  const get = (type: string): string => found.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday'),
    // Midnight formats as 24 in some locales rather than 00.
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

/** A quarter hour, which is the coarsest step that can still land on any of these. */
const STEP_MS = 15 * 60 * 1_000;
const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1_000;

/**
 * The first instant at or after `from` that reads as this moment in the zone.
 *
 * Walked rather than calculated. The arithmetic for "the next Friday at ten,
 * local, across a daylight saving change" is the kind that is wrong twice a
 * year in a way nobody notices until a season opens an hour late, and this
 * runs at most a few dozen times a week.
 */
function next(from: number, moment: Moment): number {
  const start = Math.ceil(from / STEP_MS) * STEP_MS;
  for (let at = start; at <= from + FORTNIGHT_MS; at += STEP_MS) {
    const here = inZone(at);
    if (here.weekday === moment.weekday && here.hour === moment.hour && here.minute === moment.minute) {
      return at;
    }
  }
  // Unreachable for a weekly moment inside a fortnight, and better than a
  // season silently never opening if it ever were.
  throw new Error(`no ${moment.weekday} ${moment.hour}:00 within a fortnight of ${new Date(from).toISOString()}`);
}

/** The schedule of the season that follows one ending at `endedAt`. */
export function nextSchedule(endedAt: number): {
  startsAt: number;
  entryClosesAt: number;
  endsAt: number;
} {
  const startsAt = next(endedAt, OPENS);
  const entryClosesAt = next(startsAt, ENTRIES_CLOSE);
  const endsAt = next(entryClosesAt, ENDS);
  return { startsAt, entryClosesAt, endsAt };
}

/** Every ten minutes: often enough to open within a quarter hour of the mark. */
const CHECK_MS = 10 * 60 * 1_000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function rollOnce(): Promise<void> {
  const client = await db();
  const now = Date.now();

  const ordinal = await highestRankedOrdinal(client);
  // No ranked season has ever run. The first is opened by hand, on purpose.
  if (ordinal < 1) return;

  const latest = await seasonByOrdinal(client, ordinal);
  if (!latest?.endsAt) return;
  // Still running, or still to come. Nothing to do until it is over.
  if (now < latest.endsAt) return;

  const schedule = nextSchedule(latest.endsAt);
  const following = ordinal + 1;
  const rules = rulesetFor(following);
  const hash = rulesetHashHex(rules);

  await createRankedSeason(
    client,
    {
      ordinal: following,
      name: `Season ${following}`,
      startsAt: schedule.startsAt,
      entryClosesAt: schedule.entryClosesAt,
      endsAt: schedule.endsAt,
      startingBalance: rules.startingBalance.toString(),
      entryCost: rules.entryCost.toString(),
      houseBps: rules.houseBps,
      houseThreshold: rules.houseThreshold.toString(),
      latencyMs: rules.latencyMs,
      maxPriceImpactBps: rules.maxPriceImpactBps,
      engineVersion: rules.engineVersion,
      rulesetHash: hash,
    },
    now,
  );

  console.log(
    `[rollover] opened season ${following}: ` +
      `starts ${new Date(schedule.startsAt).toISOString()}, ` +
      `entries close ${new Date(schedule.entryClosesAt).toISOString()}, ` +
      `ends ${new Date(schedule.endsAt).toISOString()}, ` +
      `ruleset ${encodeRuleset(rules).length} bytes, hash ${hash}`,
  );
}

export function startSeasonRollover(): void {
  if (started) return;
  started = true;

  const run = (): void => {
    void rollOnce().catch((error) => console.error('[rollover] failed', error));
  };

  run();
  timer = setInterval(run, CHECK_MS);
  timer.unref?.();
}

export function stopSeasonRollover(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
