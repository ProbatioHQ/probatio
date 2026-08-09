/**
 * Has anybody else used the keeper key.
 *
 * Compares what the chain holds for every trader against what our own last
 * confirmed commit predicted. Only the keeper key can write there, so a
 * mismatch is not a hint — it means the key has been used by somebody else.
 *
 * Deliberately standing rather than incidental. The keeper's own reconcile step
 * notices a foreign write only on a trader it happens to have work in flight
 * for, and a stolen key would be used on all the others.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/keeper-audit.mts
 */
import { migrate, openDatabase, seasonByOrdinal } from '@probatio/db';
import { auditRecords, type ChainGateway } from '@probatio/keeper';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';

const db = openDatabase({ url });
await migrate(db);

/**
 * The concrete gateway arrives with deployment. Until the program is on a
 * cluster there is nothing to read, and a stub that returned "fine" would be
 * worse than an honest refusal — an audit that always passes is not an audit.
 */
const gateway: ChainGateway | null = null;

if (gateway === null) {
  const seasons = await db.execute('SELECT ordinal FROM seasons WHERE ranked = 1');
  console.log('The program is not deployed, so there is no chain to audit against.');
  console.log(`${seasons.rows.length} ranked season(s) recorded locally.`);
  console.log('\nThis check cannot pass or fail yet, and is reporting neither.');
  process.exit(0);
}

const ordinals = new Map<number, number>();
for (const row of (await db.execute('SELECT id, ordinal FROM seasons')).rows) {
  ordinals.set(Number(row['id']), Number(row['ordinal']));
}

const result = await auditRecords(db, gateway, (seasonId) => {
  const ordinal = ordinals.get(seasonId);
  if (ordinal === undefined) throw new Error(`no ordinal for season ${seasonId}`);
  return ordinal;
});

console.log(`${result.checked} trader record(s) checked`);

for (const finding of result.findings) {
  console.log(`\n  ${finding.verdict.toUpperCase()}  season ${finding.seasonOrdinal}  ${finding.trader}`);
  console.log(`    expected ${finding.expected}`);
  console.log(`    on chain ${finding.onChain ?? 'nothing'}`);
  console.log(`    ${finding.detail}`);
}

if (result.compromised) {
  console.log('\nTHE KEEPER KEY HAS BEEN USED BY SOMEBODY ELSE.');
  console.log('Rotation stops further writes. It cannot undo a poisoned chain —');
  console.log('see docs/keeper-key.md and the void policy.');
  process.exit(2);
}

console.log(result.findings.length === 0 ? '\nclean' : '\nno foreign commits, but see above');
process.exit(result.findings.length === 0 ? 0 : 1);
