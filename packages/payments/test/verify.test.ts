import { describe, expect, it } from 'vitest';
import type { ConfirmedTransaction } from '@probatio/pools';
import { explainFailure, verifyPayment, type Expectation } from '../src/verify';

const PAYER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TREASURY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const REFERENCE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STRANGER = 'So11111111111111111111111111111111111111112';

const expected: Expectation = {
  payer: PAYER,
  recipient: TREASURY,
  lamports: 50_000_000n,
  reference: REFERENCE,
};

function landed(overrides: Partial<ConfirmedTransaction> = {}): ConfirmedTransaction {
  return {
    signature: 'sig',
    slot: 100,
    blockTime: 1_700_000_000,
    err: null,
    fee: 5_000n,
    accountKeys: [PAYER, TREASURY, REFERENCE, '11111111111111111111111111111111'],
    preBalances: [1_000_000_000n, 0n, 0n, 1n],
    postBalances: [949_995_000n, 50_000_000n, 0n, 1n],
    preTokenBalances: [],
    postTokenBalances: [],
    logMessages: [],
    ...overrides,
  };
}

describe('a payment that is real', () => {
  it('is accepted', () => {
    const result = verifyPayment(landed(), expected);
    expect(result.ok).toBe(true);
    expect(result.received).toBe(50_000_000n);
  });

  it('is judged on balances, not on instructions', () => {
    // The treasury gained the right amount. Nothing here reads what any
    // instruction claimed it would do.
    const result = verifyPayment(
      landed({ preBalances: [5n, 1_000n, 0n, 1n], postBalances: [5n, 50_001_000n, 0n, 1n] }),
      expected,
    );
    expect(result.ok).toBe(true);
  });
});

describe('a payment that is not', () => {
  it('refuses a transaction that is not there', () => {
    const result = verifyPayment(null, expected);
    expect(result.failure).toBe('not_found');
  });

  it('refuses a transaction that failed', () => {
    // It still exists and still cost a fee. It moved nothing.
    const result = verifyPayment(landed({ err: { InstructionError: [0, 'Custom'] } }), expected);
    expect(result.failure).toBe('failed_on_chain');
  });

  it('refuses a transfer somebody else signed', () => {
    // Otherwise any transfer to the treasury could be claimed by anyone
    // watching the chain.
    const result = verifyPayment(
      landed({ accountKeys: [STRANGER, TREASURY, REFERENCE] }),
      expected,
    );
    expect(result.failure).toBe('wrong_payer');
  });

  it('refuses a transfer that does not carry this reference', () => {
    // Without it, one payment of the right size could answer any number of
    // separate intents.
    const result = verifyPayment(
      landed({ accountKeys: [PAYER, TREASURY, '11111111111111111111111111111111'] }),
      expected,
    );
    expect(result.failure).toBe('missing_reference');
  });

  it('refuses a transaction that never touches the treasury', () => {
    const result = verifyPayment(
      landed({ accountKeys: [PAYER, STRANGER, REFERENCE] }),
      expected,
    );
    expect(result.failure).toBe('recipient_absent');
  });

  it('refuses an underpayment', () => {
    const result = verifyPayment(
      landed({ postBalances: [949_995_000n, 49_999_999n, 0n, 1n] }),
      expected,
    );
    expect(result.failure).toBe('wrong_amount');
    expect(result.received).toBe(49_999_999n);
  });

  it('refuses an overpayment too', () => {
    // The server built this transaction. A different amount means somebody
    // rebuilt it, and that is worth refusing whichever direction it went.
    const result = verifyPayment(
      landed({ postBalances: [949_995_000n, 60_000_000n, 0n, 1n] }),
      expected,
    );
    expect(result.failure).toBe('wrong_amount');
  });

  it('refuses a transfer that a later instruction took back', () => {
    // The transfer instruction is present and correct. The balances say the
    // treasury ended where it started.
    const result = verifyPayment(
      landed({ preBalances: [1_000_000_000n, 50_000_000n, 0n, 1n], postBalances: [949_995_000n, 50_000_000n, 0n, 1n] }),
      expected,
    );
    expect(result.failure).toBe('wrong_amount');
    expect(result.received).toBe(0n);
  });

  it('tells an absent treasury from one that is present and unpaid', () => {
    // Both are refusals and they are not the same refusal. An address the
    // transaction never mentions is a wrong address; one it mentions without
    // paying is a wrong amount, and confusing them would send a user chasing
    // the wrong problem.
    const absent = verifyPayment(landed(), { ...expected, recipient: STRANGER });
    const unpaid = verifyPayment(landed(), { ...expected, recipient: REFERENCE });

    expect(absent.failure).toBe('recipient_absent');
    expect(unpaid.failure).toBe('wrong_amount');
    expect(unpaid.received).toBe(0n);
  });

  it('refuses a transaction with no balances recorded', () => {
    const result = verifyPayment(landed({ preBalances: [], postBalances: [] }), expected);
    expect(result.failure).toBe('recipient_absent');
  });
});

describe('explaining a refusal', () => {
  it('has a sentence for every failure', () => {
    for (const failure of [
      'not_found',
      'failed_on_chain',
      'wrong_payer',
      'missing_reference',
      'recipient_absent',
      'wrong_amount',
    ] as const) {
      expect(explainFailure(failure).length).toBeGreaterThan(10);
    }
  });
});
