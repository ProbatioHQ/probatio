import type { ConfirmedTransaction } from '@probatio/pools';

/**
 * What actually landed.
 *
 * The only function here permitted to conclude that somebody paid. Everything
 * else in this package builds a request; this reads the chain's answer.
 *
 * Balances are the evidence, not instructions. An instruction states an
 * intention; the pre and post balances state what moved after every other
 * instruction in the transaction had its turn. A transfer that a later
 * instruction takes back looks identical to a real one if you read only the
 * instruction, and identical to nothing if you read the balances — which is
 * what it is.
 */

export type VerificationFailure =
  | 'not_found'
  | 'failed_on_chain'
  | 'wrong_payer'
  | 'missing_reference'
  | 'recipient_absent'
  | 'wrong_amount';

export interface Expectation {
  readonly payer: string;
  readonly recipient: string;
  readonly lamports: bigint;
  readonly reference: string;
}

export interface Verification {
  readonly ok: boolean;
  readonly failure: VerificationFailure | null;
  /** What the recipient actually gained. Present whenever it could be read. */
  readonly received: bigint | null;
  readonly detail: string | null;
}

function fail(failure: VerificationFailure, detail: string, received: bigint | null = null): Verification {
  return { ok: false, failure, received, detail };
}

export function verifyPayment(
  transaction: ConfirmedTransaction | null,
  expected: Expectation,
): Verification {
  if (!transaction) {
    return fail('not_found', 'the transaction is not on chain');
  }

  if (transaction.err !== null && transaction.err !== undefined) {
    // A failed transaction still costs a fee and still exists. It moved
    // nothing, and crediting it would be crediting a failure.
    return fail('failed_on_chain', 'the transaction failed');
  }

  // The fee payer is always the first key, and is always a signer. Requiring it
  // to be the signed-in wallet is what stops anyone claiming a stranger's
  // transfer to the treasury as their own entry.
  if (transaction.accountKeys[0] !== expected.payer) {
    return fail(
      'wrong_payer',
      `signed by ${transaction.accountKeys[0] ?? 'nobody'}, expected ${expected.payer}`,
    );
  }

  if (!transaction.accountKeys.includes(expected.reference)) {
    // Without this, one transfer of the right size to the treasury could be
    // presented against any number of separate intents.
    return fail('missing_reference', 'the transaction does not carry this payment reference');
  }

  const recipientIndex = transaction.accountKeys.indexOf(expected.recipient);
  if (recipientIndex === -1) {
    return fail('recipient_absent', 'the transaction does not touch the treasury');
  }

  const before = transaction.preBalances[recipientIndex];
  const after = transaction.postBalances[recipientIndex];
  if (before === undefined || after === undefined) {
    return fail('recipient_absent', 'the transaction has no balances for the treasury');
  }

  const received = after - before;
  if (received !== expected.lamports) {
    // Exact, not "at least". The server built this transaction; a different
    // amount means it was rebuilt by someone else, and an overpayment is as
    // much a sign of that as an underpayment.
    return fail('wrong_amount', `treasury gained ${received}, expected ${expected.lamports}`, received);
  }

  return { ok: true, failure: null, received, detail: null };
}

export function explainFailure(failure: VerificationFailure): string {
  switch (failure) {
    case 'not_found':
      return 'That transaction has not landed yet. Give it a moment and try again.';
    case 'failed_on_chain':
      return 'That transaction failed on chain, so nothing was paid.';
    case 'wrong_payer':
      return 'That transaction was signed by a different wallet.';
    case 'missing_reference':
      return 'That transaction does not match this payment.';
    case 'recipient_absent':
      return 'That transaction did not pay the entry address.';
    case 'wrong_amount':
      return 'That transaction paid a different amount than the entry costs.';
  }
}
