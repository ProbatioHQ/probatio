/**
 * The message encoder, checked against the network.
 *
 * Takes real transactions off a recent mainnet block, decodes each message with
 * our codec, re-encodes it, and requires the bytes back exactly. A transaction
 * format is not something to be confident about from a specification — the
 * network is the only authority on it, and this is the cheapest way to ask.
 */
import {
  compileMessage,
  decodeCompactU16,
  decodeMessage,
  encodeMessage,
  type Instruction,
} from '@probatio/payments';

const endpoint = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

const slot = await rpc<number>('getSlot', [{ commitment: 'finalized' }]);
console.log(`reading block ${slot}…`);

const block = await rpc<{ transactions: { transaction: [string, string] }[] }>('getBlock', [
  slot,
  {
    encoding: 'base64',
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'full',
    rewards: false,
  },
]);

let legacy = 0;
let versioned = 0;
let exact = 0;
let orderChecked = 0;
let orderMatched = 0;
let notComparable = 0;
const failures: string[] = [];
const orderFailures: string[] = [];

for (const entry of block.transactions) {
  const raw = Uint8Array.from(Buffer.from(entry.transaction[0], 'base64'));

  // Skip the signature array to reach the message.
  const count = decodeCompactU16(raw, 0);
  const messageStart = count.next + count.value * 64;
  const messageBytes = raw.subarray(messageStart);

  if ((messageBytes[0]! & 0x80) !== 0) {
    versioned += 1;
    continue;
  }
  legacy += 1;

  try {
    const reencoded = encodeMessage(decodeMessage(messageBytes));
    if (
      reencoded.length === messageBytes.length &&
      reencoded.every((byte, index) => byte === messageBytes[index])
    ) {
      exact += 1;
    } else {
      failures.push(`byte mismatch (${messageBytes.length} vs ${reencoded.length})`);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    continue;
  }

  // Round-tripping only proves the decoder. The ordering rules are what a NEW
  // transaction depends on, so rebuild each real message from its instructions
  // and require our compiler to choose the same account order the validator
  // accepted.
  try {
    const message = decodeMessage(messageBytes);
    const signers = message.numRequiredSignatures;
    const readonlySigned = message.numReadonlySignedAccounts;
    const readonlyUnsigned = message.numReadonlyUnsignedAccounts;
    const total = message.accountKeys.length;

    const isSigner = (index: number): boolean => index < signers;
    const isWritable = (index: number): boolean =>
      index < signers - readonlySigned || (index >= signers && index < total - readonlyUnsigned);

    const instructions: Instruction[] = message.instructions.map((compiled) => ({
      programId: message.accountKeys[compiled.programIdIndex]!,
      keys: compiled.accountIndexes.map((index) => ({
        pubkey: message.accountKeys[index]!,
        isSigner: isSigner(index),
        isWritable: isWritable(index),
      })),
      data: compiled.data,
    }));

    // A message may carry account keys no instruction references — the
    // reference pattern, among others. Rebuilding from instructions alone
    // cannot recreate those, so those messages say nothing about our ordering
    // either way and are counted apart rather than scored as failures.
    const referenced = new Set<string>();
    for (const instruction of instructions) {
      referenced.add(instruction.programId);
      for (const key of instruction.keys) referenced.add(key.pubkey);
    }
    referenced.add(message.accountKeys[0]!);
    if (referenced.size !== message.accountKeys.length) {
      notComparable += 1;
      continue;
    }

    const rebuilt = compileMessage(
      message.accountKeys[0]!,
      message.recentBlockhash,
      instructions,
    );

    orderChecked += 1;

    // Order WITHIN a group is not fixed by the protocol — any order is valid
    // so long as the group boundaries are right, and different builders differ.
    // What must match is the header and which group each key landed in, since
    // that is what grants or denies signing and writing.
    const groupsOf = (msg: typeof message): Map<string, string> => {
      const groups = new Map<string, string>();
      const sig = msg.numRequiredSignatures;
      const roSigned = msg.numReadonlySignedAccounts;
      const roUnsigned = msg.numReadonlyUnsignedAccounts;
      const size = msg.accountKeys.length;
      msg.accountKeys.forEach((key, index) => {
        const signer = index < sig;
        const writable =
          index < sig - roSigned || (index >= sig && index < size - roUnsigned);
        groups.set(key, `${signer ? 's' : '-'}${writable ? 'w' : '-'}`);
      });
      return groups;
    };

    const original = groupsOf(message);
    const ours = groupsOf(rebuilt);

    const headerMatches =
      rebuilt.numRequiredSignatures === message.numRequiredSignatures &&
      rebuilt.numReadonlySignedAccounts === message.numReadonlySignedAccounts &&
      rebuilt.numReadonlyUnsignedAccounts === message.numReadonlyUnsignedAccounts;

    const permissionsMatch =
      original.size === ours.size &&
      [...original].every(([key, group]) => ours.get(key) === group);

    if (headerMatches && permissionsMatch) {
      orderMatched += 1;
    } else {
      orderFailures.push(
        !headerMatches
          ? `header ${message.numRequiredSignatures}/${message.numReadonlySignedAccounts}/${message.numReadonlyUnsignedAccounts}` +
            ` vs ours ${rebuilt.numRequiredSignatures}/${rebuilt.numReadonlySignedAccounts}/${rebuilt.numReadonlyUnsignedAccounts}`
          : 'a key landed in a different permission group',
      );
    }
  } catch (error) {
    orderFailures.push(error instanceof Error ? error.message : String(error));
  }
}

console.log(`\n${block.transactions.length} transactions in the block`);
console.log(`  ${versioned} versioned (skipped — this codec is legacy only)`);
console.log(`  ${legacy} legacy`);
console.log(`  ${exact} re-encoded to the exact same bytes`);
console.log(`  ${orderMatched} of ${orderChecked} rebuilt with identical header and permissions`);
console.log(`  ${notComparable} carried keys no instruction references (not comparable)`);

if (failures.length > 0) {
  console.log(`\n${failures.length} failures:`);
  for (const failure of failures.slice(0, 5)) console.log(`  ${failure}`);
  process.exit(1);
}

if (orderFailures.length > 0) {
  console.log(`\n${orderFailures.length} account-order mismatches:`);
  for (const failure of orderFailures.slice(0, 5)) console.log(`  ${failure}`);
}

console.log(legacy > 0 ? '\nround trip exact on every legacy message' : '\nno legacy messages in this block');
