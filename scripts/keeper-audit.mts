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
import { readFileSync } from 'node:fs';
import { migrate, openDatabase } from '@probatio/db';
import { RpcClient } from '@probatio/pools';
import { auditRecords, SolanaGateway, type ChainGateway } from '@probatio/keeper';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const endpoint = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const keypairPath = process.env['KEEPER_KEYPAIR'] ?? process.argv[2];

const db = openDatabase({ url });
await migrate(db);

/*
 * The gateway, actually built.
 *
 * This was `const gateway: ChainGateway | null = null` with a comment saying
 * the concrete one "arrives with deployment". It arrived. `SolanaGateway` has
 * existed for a long time, is exercised by the drill, and commits real batches
 * — but this script kept its placeholder, so it printed "the program is not
 * deployed" no matter what was deployed, and exited zero.
 *
 * That matters more here than in most places. This is the standing check for
 * whether somebody else has used the keeper key, and a check that cannot run
 * is indistinguishable from one that always passes. It was reporting nothing
 * while claiming to report nothing, which is the only reason it was not worse.
 *
 * Reading a record needs an address, not a signature, but the gateway takes
 * the key it signs with — so the audit is run with the same key the keeper
 * uses, which is what an operator has to hand anyway.
 */
if (!keypairPath) {
  console.error('set KEEPER_KEYPAIR, or pass a keypair path, so the audit can read the chain');
  process.exit(1);
}

let gateway: ChainGateway;
try {
  const secret = Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8')) as number[]);
  gateway = new SolanaGateway({
    rpc: new RpcClient({ endpoint, timeoutMs: 30_000, minIntervalMs: 120 }),
    keeperSecret: secret,
  });
} catch (error) {
  console.error(`could not build a gateway from ${keypairPath}:`, error);
  process.exit(1);
}

console.log(`auditing against ${endpoint}\n`);

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
