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
 * The seed season is ordinal 0: before the first numbered one, and carrying a
 * prize that is put up rather than paid for by entries, so the first board is
 * worth being on before anybody has heard of this.
 *
 * It used to be forced free, because the void policy promises full refunds and
 * the program had no instruction that could pay one — a season that took money
 * it could not give back. `refund_entry` closed that, so the seed season is now
 * priced like any other and `--free` is an explicit choice rather than the only
 * safe option.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/open-season.mts [--at <iso>] [--dry]
 *   ... --seed --sponsor 2               open season 0 with a 2 SOL prize on top
 *   ... --free                           charge nothing to enter
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

const seed = process.argv.includes('--seed');
const free = process.argv.includes('--free');

const sponsorIndex = process.argv.indexOf('--sponsor');
const sponsorSol =
  sponsorIndex !== -1 && process.argv[sponsorIndex + 1] ? Number(process.argv[sponsorIndex + 1]) : 0;

if (Number.isNaN(sponsorSol) || sponsorSol < 0) {
  console.error('--sponsor takes a number of SOL');
  process.exit(1);
}

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
// The seed season is ordinal 0: before the first real one, and clearly not
// part of the numbered sequence people will be competing in.
const ordinal = seed ? 0 : Math.max(1, previousOrdinal + 1);

// Back to back with no gap: the next season starts exactly where the last one
// ended. A gap is a stretch in which a ranked trade counts toward nothing.
const previous = previousOrdinal > 0 ? await seasonByOrdinal(db, previousOrdinal) : null;
const start = startsAt ?? previous?.endsAt ?? now;

const base = rulesetFor(ordinal);
const entryCost = free ? 0n : base.entryCost;

// The hash has to describe the season that actually runs. Hashing the standard
// ruleset while opening a free season would publish a commitment to an entry
// cost nobody is charged — the one thing the hash exists to make impossible.
const rules = free ? { ...base, entryCost } : base;

const schedule = scheduleFrom(start, rules.durationMs, rules.entryWindowMs);
const hash = rulesetHashHex(rules);
const sponsorLamports = BigInt(Math.round(sponsorSol * 1e9));

if (seed && sponsorLamports === 0n) {
  // A seed season with no prize is a practice mode with a leaderboard. The
  // point of this one is that the board is worth being on before anybody has
  // heard of it.
  console.error('a seed season needs a prize: pass --sponsor <sol>');
  process.exit(1);
}
if (!seed && sponsorLamports > 0n) {
  console.error('only the seed season takes a sponsored prize');
  process.exit(1);
}

console.log(seed ? 'Season 0 (seed)' : `Season ${ordinal}`);
console.log(`  starts        ${new Date(schedule.startsAt).toISOString()}`);
console.log(`  entries close ${new Date(schedule.entryClosesAt).toISOString()}`);
console.log(`  ends          ${new Date(schedule.endsAt).toISOString()}`);
console.log(`  entry         ${entryCost} lamports${free ? ' (free)' : ''}`);
if (sponsorLamports > 0n) console.log(`  prize         ${sponsorLamports} lamports (sponsored)`);
console.log(`  balance       ${rules.startingBalance} lamports`);
console.log(`  ruleset       ${encodeRuleset(rules).length} bytes`);
console.log(`  hash          ${hash}`);
console.log(`\n  init_season scoring_formula_hash must be this exact hash.`);

if (!seed && previous && start < previous.endsAt!) {
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
    sponsorLamports: sponsorLamports.toString(),
  },
  now,
);

console.log(`\nopened as season id ${id}`);

if (seed) {
  console.log('\nThe prize is recorded here. It still has to be sent to the season vault');
  console.log('on chain before anybody can claim it — the vault pays what it holds, not');
  console.log('what this database says.');
}
