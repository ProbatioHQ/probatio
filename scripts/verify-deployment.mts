/**
 * Who can replace the program, and is what is deployed what we published.
 *
 * Two questions, and the second is why the first is not enough. A burned
 * upgrade authority fixes a program forever without saying which program was
 * fixed — so the deployed bytecode is hashed here too, against a local build
 * anybody can reproduce from the source.
 *
 * Every guarantee the on-chain half makes is a guarantee about the code
 * currently deployed. This is the command that checks the code currently
 * deployed is the code the guarantees were written about.
 *
 *   npx tsx scripts/verify-deployment.mts [programId]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { RpcClient, decodeProgramData, findProgramAddress, BPF_UPGRADEABLE_LOADER } from '@probatio/pools';
import { PROGRAM_ID } from '@probatio/keeper';
import bs58 from 'bs58';

/*
 * Imported, never copied.
 *
 * This carried its own hardcoded address, and it was the wrong one — the id
 * the source used before `anchor keys sync` corrected it to match the program
 * keypair. So the one command the trust page tells a sceptic to run looked at
 * an address nothing was ever deployed to. It would have reported NOT DEPLOYED
 * forever, including the day after a real mainnet deployment, and if anybody
 * else ever deployed to that address it would have reported their upgrade
 * authority as ours.
 *
 * A second copy of a constant is a second thing to keep correct, and this is
 * the second time that copy has been wrong. There is now one source and a test
 * that it still matches `declare_id!`.
 */
const programId = process.argv[2] ?? PROGRAM_ID;
const endpoint = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';
const localBinary = 'program/target/deploy/probatio.so';

const rpc = new RpcClient({ endpoint, timeoutMs: 30_000, minIntervalMs: 120 });

console.log(`program   ${programId}`);
console.log(`endpoint  ${endpoint}\n`);

const program = await rpc.getAccount(programId);
if (!program) {
  console.log('NOT DEPLOYED — there is no account at this address on this cluster.');
  console.log('\nUntil it is deployed, every claim about what the program does is a claim');
  console.log('about source code, not about anything running.');
  process.exit(0);
}

if (program.owner !== BPF_UPGRADEABLE_LOADER) {
  console.log(`owner     ${program.owner}`);
  console.log('\nThis program is not owned by the upgradeable loader, so it cannot be');
  console.log('replaced at all. That is stronger than a burned authority.');
  process.exit(0);
}

const dataAddress = findProgramAddress([bs58.decode(programId)], BPF_UPGRADEABLE_LOADER).address;
const dataAccount = await rpc.getAccount(dataAddress);
if (!dataAccount) {
  console.log('the program exists but its data account does not — this should be impossible');
  process.exit(1);
}

const decoded = decodeProgramData(dataAccount.data);

console.log(`data account   ${dataAddress}`);
console.log(`last deployed  slot ${decoded.lastDeploySlot}`);
console.log(`bytecode       ${decoded.bytecode.length} bytes`);
console.log(`on-chain hash  ${createHash('sha256').update(decoded.bytecode).digest('hex')}`);

console.log('\nUpgrade authority');
if (decoded.upgradeAuthority === null) {
  console.log('  BURNED — nobody can replace this program.');
} else {
  console.log(`  ${decoded.upgradeAuthority}`);
  console.log('\n  This key can replace the program with a different one, including one');
  console.log('  that rewrites records the current program treats as append-only.');
  console.log('  Records are not unfakeable while it exists. They are unfakeable');
  console.log('  without a publicly visible upgrade, which is a weaker and true claim.');
}

if (existsSync(localBinary)) {
  // The deployed bytes are padded to the account size, so a local build is
  // compared against the same length rather than against the whole account.
  const local = readFileSync(localBinary);
  const trimmed = decoded.bytecode.subarray(0, local.length);
  const localHash = createHash('sha256').update(local).digest('hex');
  const chainHash = createHash('sha256').update(trimmed).digest('hex');

  console.log('\nLocal build');
  console.log(`  ${localBinary}`);
  console.log(`  ${local.length} bytes, sha256 ${localHash}`);
  console.log(
    localHash === chainHash
      ? '  MATCHES the deployed bytecode'
      : '  DOES NOT MATCH the deployed bytecode',
  );
  if (localHash !== chainHash) {
    console.log('\n  A mismatch is not proof of anything on its own: Solana builds are not');
    console.log('  reproducible by default, so two honest builds of the same source can');
    console.log('  differ. It does mean this cannot be used as evidence yet.');
  }
} else {
  console.log(`\nNo local build at ${localBinary} to compare against.`);
}
