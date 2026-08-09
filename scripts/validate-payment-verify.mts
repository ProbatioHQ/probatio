/**
 * The payment verifier, checked against a real transfer.
 *
 * Finds an actual SOL transfer on mainnet, reads it exactly the way the
 * confirmation route does, and requires the verifier to accept it — then
 * alters one field at a time and requires a refusal each time.
 *
 * Unit tests prove the verifier is consistent with the fixtures I wrote. Only
 * this proves the fixtures resemble what the chain returns.
 */
import { RpcClient } from '@probatio/pools';
import { verifyPayment, SYSTEM_PROGRAM_ID } from '@probatio/payments';

const rpc = new RpcClient({
  endpoint: process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
  timeoutMs: 30_000,
  minIntervalMs: 120,
});

async function call<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const slot = (await call<number>('getSlot', [{ commitment: 'finalized' }])) - 40;
const block = await call<{
  transactions: {
    transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
    meta: { err: unknown; preBalances: number[]; postBalances: number[] } | null;
  }[];
}>('getBlock', [
  slot,
  { encoding: 'json', maxSupportedTransactionVersion: 0, transactionDetails: 'full', rewards: false },
]);

// A plain transfer: succeeded, one System instruction over two accounts, and a
// recipient whose balance actually rose.
const candidate = block.transactions.find((entry) => {
  if (!entry.meta || entry.meta.err !== null) return false;
  const keys = entry.transaction.message.accountKeys;
  const transfers = entry.transaction.message.instructions.filter(
    (instruction) =>
      keys[instruction.programIdIndex] === SYSTEM_PROGRAM_ID && instruction.accounts.length === 2,
  );
  if (transfers.length !== 1) return false;
  const recipient = transfers[0]!.accounts[1]!;
  return (entry.meta.postBalances[recipient] ?? 0) > (entry.meta.preBalances[recipient] ?? 0);
});

if (!candidate) {
  console.log(`no plain transfer found in slot ${slot}; try again`);
  process.exit(0);
}

const keys = candidate.transaction.message.accountKeys;
const instruction = candidate.transaction.message.instructions.find(
  (item) => keys[item.programIdIndex] === SYSTEM_PROGRAM_ID && item.accounts.length === 2,
)!;

const payer = keys[0]!;
const recipient = keys[instruction.accounts[1]!]!;
const recipientIndex = instruction.accounts[1]!;
const moved =
  BigInt(candidate.meta!.postBalances[recipientIndex]!) -
  BigInt(candidate.meta!.preBalances[recipientIndex]!);

// Read it back through the same client the route uses, rather than reusing the
// block's copy — the route's decoding is part of what is being tested.
const signatures = (await call<{ signatures: string[] }>('getBlock', [
  slot,
  { encoding: 'json', maxSupportedTransactionVersion: 0, transactionDetails: 'signatures', rewards: false },
])).signatures;

const index = block.transactions.indexOf(candidate);
const txSignature = signatures[index]!;

console.log(`transfer ${txSignature.slice(0, 12)}…`);
console.log(`  payer     ${payer}`);
console.log(`  recipient ${recipient}`);
console.log(`  moved     ${moved} lamports\n`);

const fetched = await rpc.getTransaction(txSignature, 'finalized');
if (!fetched) {
  console.log('the route could not read it back');
  process.exit(1);
}

// Real transfers carry no reference of ours, so stand in the recipient — the
// point here is the balance and payer logic against a genuine transaction.
const expectation = { payer, recipient, lamports: moved, reference: recipient };

const cases: [string, ReturnType<typeof verifyPayment>, string | null][] = [
  ['the real transfer', verifyPayment(fetched, expectation), null],
  ['a stranger claiming it', verifyPayment(fetched, { ...expectation, payer: SYSTEM_PROGRAM_ID }), 'wrong_payer'],
  ['one lamport short', verifyPayment(fetched, { ...expectation, lamports: moved - 1n }), 'wrong_amount'],
  ['one lamport over', verifyPayment(fetched, { ...expectation, lamports: moved + 1n }), 'wrong_amount'],
  // An address the transaction genuinely does not contain. Naming one that IS
  // present — the System program, say — is a different case, and the verifier
  // correctly calls that a wrong amount rather than an absent recipient.
  ['a treasury not in the transaction', verifyPayment(fetched, { ...expectation, recipient: 'Vote111111111111111111111111111111111111111' }), 'recipient_absent'],
  ['an address present but unpaid', verifyPayment(fetched, { ...expectation, recipient: SYSTEM_PROGRAM_ID }), 'wrong_amount'],
  ['a reference it does not carry', verifyPayment(fetched, { ...expectation, reference: 'So11111111111111111111111111111111111111112' }), 'missing_reference'],
  ['nothing on chain', verifyPayment(null, expectation), 'not_found'],
];

let failures = 0;
for (const [name, result, expected] of cases) {
  const got = result.ok ? 'accepted' : result.failure;
  const want = expected === null ? 'accepted' : expected;
  const pass = got === want;
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} ${got}`);
}

console.log(failures === 0 ? '\nverifier agrees with the chain' : `\n${failures} disagreements`);
process.exit(failures === 0 ? 0 : 1);
