/**
 * Measure a season against the void policy.
 *
 * Reports every threshold, not only the ones that fired, because the report is
 * the evidence. Publishing only breaches would mean asking people to take our
 * word for the rest.
 *
 * Two of the five conditions are measured from the database and are exact. The
 * other two need availability monitoring that does not exist yet; they are
 * reported as unmeasured rather than as zero, because reporting an unwatched
 * outage as no outage would quietly assert a season was clean when nobody
 * looked.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/assess-season.mts <ordinal>
 */
import {
  migrate,
  openDatabase,
  outagesBetween,
  seasonByOrdinal,
  uncommittedTrades,
} from '@probatio/db';
import { outageMinutes } from '@probatio/health';
import { assessVoid, explainCondition, rulesetFor, voidableNow } from '@probatio/seasons';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const ordinal = Number(process.argv[2] ?? '1');

/**
 * An absent measurement is absent, not zero.
 *
 * `Number('')` is 0, not NaN, so reading an unset variable straight through
 * would report an outage nobody watched for as an outage that did not happen —
 * the precise failure this script exists to avoid.
 */
function minutesFrom(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const unmeasured: string[] = [];

const db = openDatabase({ url });
await migrate(db);

const season = await seasonByOrdinal(db, ordinal);
if (!season) {
  console.error(`no season ${ordinal}`);
  process.exit(1);
}

const rules = rulesetFor(ordinal);

// Trades in this season with no commitment covering them.
const pending = (await uncommittedTrades(db, 100_000)).filter(
  (trade) => trade.seasonId === season.id,
);

const versions = await db.execute({
  sql: 'SELECT DISTINCT engine_version AS v FROM trades WHERE season_id = ?',
  args: [season.id],
});

// Feed and chain availability come from the recorded outage intervals rather
// than from somebody's recollection. An override is still accepted for an
// incident the probe slept through.
const seasonFrom = season.startsAt ?? 0;
const seasonTo = Math.min(season.endsAt ?? Date.now(), Date.now());
const recorded = (await outagesBetween(db, seasonFrom, seasonTo)).map((row) => ({
  dependency: row.dependency,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  detail: row.detail,
}));

const measure = (dependency: 'feed' | 'rpc'): number =>
  outageMinutes(
    recorded.filter((row) => row.dependency === dependency),
    seasonFrom,
    seasonTo,
    Date.now(),
  );

const overrodeFeed = minutesFrom('FEED_OUTAGE_MINUTES');
const overrodeChain = minutesFrom('CHAIN_HALT_MINUTES');
const feedOutageMinutes = overrodeFeed ?? measure('feed');
const chainHaltMinutes = overrodeChain ?? measure('rpc');

// Irreproducible trades are what the verifier answers, and it needs the pool
// snapshots rebuilt per trade. Reported as unmeasured rather than assumed zero.
unmeasured.push('irreproducible_trades');

// No recorded probes at all is not the same as no outages. It is a season
// nobody watched, and saying otherwise would declare it clean on no evidence.
if (recorded.length === 0) {
  if (overrodeFeed === null) unmeasured.push('feed_outage');
  if (overrodeChain === null) unmeasured.push('chain_halt');
}

const verdict = assessVoid(
  {
    feedOutageMinutes,
    chainHaltMinutes,
    uncommittedTrades: pending.length,
    irreproducibleTrades: 0,
    engineVersions: versions.rows.map((row) => Number(row['v'])),
    declaredEngineVersion: rules.engineVersion,
  },
  rules.voidPolicy,
);

console.log(`${season.name} (ordinal ${ordinal})`);
console.log(`  ruleset ${season.rulesetHash}`);
console.log(`  voidable: ${voidableNow(season.status === 'finalized' ? season.endsAt : null)}\n`);

for (const row of verdict.report) {
  const state = unmeasured.includes(row.condition)
    ? 'UNMEASURED'
    : row.breached
      ? 'BREACHED'
      : 'ok';
  console.log(`  ${state.padEnd(11)} ${row.condition.padEnd(23)} ${row.measured} / ${row.threshold}`);
}

if (unmeasured.length > 0) {
  console.log(`\n  ${unmeasured.length} condition(s) not measured here:`);
  for (const condition of unmeasured) console.log(`    ${condition}`);
  console.log('  A season cannot be declared clean while any condition is unmeasured.');
}

console.log(`\nverdict: ${verdict.isVoid ? 'VOID' : unmeasured.length > 0 ? 'INCOMPLETE' : 'stands'}`);
for (const condition of verdict.conditions) {
  console.log(`  ${condition}: ${explainCondition(condition)}`);
}
