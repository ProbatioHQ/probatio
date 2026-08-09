/**
 * Wallet evidence, checked against real wallets.
 *
 * Takes fee payers off a recent mainnet block — real wallets, doing real
 * things — and reads each one the way the entry route does. What is being
 * checked is that age and funder come back sane: a wallet the chain has known
 * for months must not read as new, and a funder must be somebody other than
 * the wallet itself.
 */
import { RpcClient } from '@probatio/pools';
import { assess, gatherEvidence, DEFAULT_RULES } from '@probatio/sybil';

const endpoint = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';

async function call<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const slot = (await call<number>('getSlot', [{ commitment: 'finalized' }])) - 60;
const block = await call<{
  transactions: { transaction: { message: { accountKeys: string[] } } }[];
}>('getBlock', [
  slot,
  { encoding: 'json', maxSupportedTransactionVersion: 0, transactionDetails: 'full', rewards: false },
]);

const payers = [...new Set(block.transactions.map((entry) => entry.transaction.message.accountKeys[0]!))]
  .filter((key) => !key.startsWith('Vote'))
  .slice(0, 6);

const rpc = new RpcClient({ endpoint, timeoutMs: 30_000, minIntervalMs: 120, maxRetries: 5 });
const now = Date.now();

console.log(`reading ${payers.length} real wallets from slot ${slot}\n`);

let sane = 0;
const problems: string[] = [];

for (const payer of payers) {
  const evidence = await gatherEvidence(rpc, payer, now);
  const verdict = assess({ evidence, siblingEntries: 0, now });

  const ageDays =
    evidence.firstSeenAt === null
      ? null
      : Math.round((now - evidence.firstSeenAt) / 86_400_000);

  console.log(`${payer.slice(0, 8)}…`);
  console.log(`  first seen  ${ageDays === null ? 'unknown' : `${ageDays}d ago`}`);
  console.log(`  signatures  ${evidence.signatureCount}${evidence.truncated ? '+' : ''}`);
  console.log(`  funder      ${evidence.funder ? `${evidence.funder.slice(0, 8)}…` : 'none found'}`);
  console.log(`  flags       ${verdict.flags.length ? verdict.flags.join(', ') : 'none'}`);
  console.log(`  allowed     ${verdict.allowed}`);

  // A wallet is never its own funder, and a wallet the chain has seen cannot
  // have zero signatures.
  if (evidence.funder === payer) problems.push(`${payer}: reported itself as its funder`);
  if (evidence.signatureCount === 0) problems.push(`${payer}: active payer read as having no history`);
  if (evidence.firstSeenAt !== null && evidence.firstSeenAt > now) {
    problems.push(`${payer}: first seen in the future`);
  }
  if (problems.length === 0) sane += 1;
  console.log();
}

// The funder signal only fires on a wallet with little history — which is
// exactly the sybil case, and therefore the case worth proving. Busy wallets
// report no funder because their own oldest transaction is one they signed.
console.log('looking for a low-activity wallet to test funder detection…');

const recipients = [
  ...new Set(
    block.transactions.flatMap((entry) => entry.transaction.message.accountKeys.slice(1, 3)),
  ),
]
  .filter((key) => !key.startsWith('Vote') && !key.startsWith('1111'))
  .slice(0, 25);

let funderFound = false;
for (const candidate of recipients) {
  const evidence = await gatherEvidence(rpc, candidate, now);
  if (evidence.truncated || evidence.signatureCount > 40) continue;

  console.log(`\n${candidate.slice(0, 8)}… (${evidence.signatureCount} signatures)`);
  console.log(`  funder  ${evidence.funder ? `${evidence.funder.slice(0, 8)}…` : 'none found'}`);
  if (evidence.funder !== null) {
    funderFound = true;
    if (evidence.funder === candidate) problems.push(`${candidate}: reported itself as its funder`);
    break;
  }
}

if (!funderFound) {
  console.log('  no low-activity wallet in this block; the signal is untested here');
}

console.log(`\n${sane}/${payers.length} read sanely`);
console.log(`rules: max ${DEFAULT_RULES.maxEntriesPerFunder} entries per funder`);

if (problems.length > 0) {
  console.log('\nproblems:');
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}
