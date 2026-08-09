/**
 * Open the next ranked season.
 *
 * Deliberately a command somebody runs, not a job that fires on a timer. A
 * season is a thing people pay to enter; starting one is a decision, and the
 * first one especially should begin when somebody meant it to.
 *
 * The ruleset hash printed here is what goes on chain with init_season. If the
 * two ever disagree, the published rules are not the rules.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/open-season.mts [--at <iso>] [--dry]
 */
import {
  createRankedSeason,
  currentRankedSeason,
  highestRankedOrdinal,
  migrate,
  openDatabase,
  seasonByOrdinal,
} from '@probatio/db';
import { rulesetFor, rulesetHashHex, scheduleFrom, encodeRuleset } from '@probatio/seasons';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const dry = process.argv.includes('--dry');

const atIndex = process.argv.indexOf('--at');
const startsAt =
  atIndex !== -1 && process.argv[atIndex + 1]
    ? Date.parse(process.argv[atIndex + 1]!)
    : null;

if (startsAt !== null && Number.isNaN(startsAt)) {
  console.error('--at needs an ISO timestamp, e.g. 2026-08-10T18:00:00Z');
  process.exit(1);
}

const db = openDatabase({ url });
await migrate(db);

const now = Date.now();
const previousOrdinal = await highestRankedOrdinal(db);
const ordinal = previousOrdinal + 1;

// Back to back with no gap: the next season starts exactly where the last one
// ended. A gap is a stretch in which a ranked trade counts toward nothing.
const previous = previousOrdinal > 0 ? await seasonByOrdinal(db, previousOrdinal) : null;
const start = startsAt ?? previous?.endsAt ?? now;

const rules = rulesetFor(ordinal);
const schedule = scheduleFrom(start, rules.durationMs, rules.entryWindowMs);
const hash = rulesetHashHex(rules);

console.log(`Season ${ordinal}`);
console.log(`  starts        ${new Date(schedule.startsAt).toISOString()}`);
console.log(`  entries close ${new Date(schedule.entryClosesAt).toISOString()}`);
console.log(`  ends          ${new Date(schedule.endsAt).toISOString()}`);
console.log(`  entry         ${rules.entryCost} lamports`);
console.log(`  balance       ${rules.startingBalance} lamports`);
console.log(`  ruleset       ${encodeRuleset(rules).length} bytes`);
console.log(`  hash          ${hash}`);
console.log(`\n  init_season scoring_formula_hash must be this exact hash.`);

if (previous && start < previous.endsAt!) {
  console.error(`\nrefusing: season ${previousOrdinal} does not end until ${new Date(previous.endsAt!).toISOString()}`);
  process.exit(1);
}

const running = await currentRankedSeason(db, now);
if (running && running.endsAt !== null && running.endsAt > now && startsAt === null) {
  console.log(`\nseason ${running.ordinal} is still running; passing --at would schedule after it`);
}

if (dry) {
  console.log('\ndry run, nothing written');
  process.exit(0);
}

const id = await createRankedSeason(
  db,
  {
    ordinal,
    name: `Season ${ordinal}`,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    entryClosesAt: schedule.entryClosesAt,
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

console.log(`\nopened as season id ${id}`);
