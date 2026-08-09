import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { buildPaymentMessage, buildPaymentTransaction, createIntent } from '../src/intent';
import { MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, decodeMessage } from '../src/message';

const PAYER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TREASURY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const BLOCKHASH = 'So11111111111111111111111111111111111111112';
const NOW = 1_700_000_000_000;

function fixedRandom(byte: number) {
  return (length: number) => new Uint8Array(length).fill(byte);
}

function intent(overrides: Partial<Parameters<typeof createIntent>[0]> = {}) {
  return createIntent({
    payer: PAYER,
    recipient: TREASURY,
    lamports: 50_000_000n,
    purpose: 'season_entry',
    seasonOrdinal: 1,
    now: NOW,
    randomBytes: fixedRandom(7),
    ...overrides,
  });
}

describe('creating an intent', () => {
  it('carries what was asked for', () => {
    const result = intent();
    expect(result.payer).toBe(PAYER);
    expect(result.recipient).toBe(TREASURY);
    expect(result.lamports).toBe(50_000_000n);
    expect(result.expiresAt).toBe(NOW + 10 * 60 * 1_000);
  });

  it('mints a 32-byte reference', () => {
    expect(bs58.decode(intent().reference)).toHaveLength(32);
  });

  it('mints a different reference every time', () => {
    // Two intents sharing a reference would let one payment answer both.
    const a = createIntent({
      payer: PAYER, recipient: TREASURY, lamports: 1n, purpose: 'season_entry', now: NOW,
      randomBytes: fixedRandom(1),
    });
    const b = createIntent({
      payer: PAYER, recipient: TREASURY, lamports: 1n, purpose: 'season_entry', now: NOW,
      randomBytes: fixedRandom(2),
    });
    expect(a.reference).not.toBe(b.reference);
  });

  it('names the season in the memo', () => {
    expect(intent({ seasonOrdinal: 3 }).memo).toContain('season 3');
  });

  it('refuses a payment of nothing', () => {
    expect(() => intent({ lamports: 0n })).toThrow();
    expect(() => intent({ lamports: -1n })).toThrow();
  });
});

describe('the transaction a wallet is handed', () => {
  it('transfers to the treasury and carries the reference', () => {
    const created = intent();
    const message = buildPaymentMessage(created, BLOCKHASH);

    expect(message.accountKeys[0]).toBe(PAYER);
    expect(message.accountKeys).toContain(TREASURY);
    expect(message.accountKeys).toContain(created.reference);
    expect(message.accountKeys).toContain(SYSTEM_PROGRAM_ID);
    expect(message.accountKeys).toContain(MEMO_PROGRAM_ID);
    expect(message.recentBlockhash).toBe(BLOCKHASH);
  });

  it('asks for exactly one signature', () => {
    // The user's. The server signs nothing and holds no key here.
    expect(buildPaymentMessage(intent(), BLOCKHASH).numRequiredSignatures).toBe(1);
  });

  it('serializes to base64 that decodes back to the same message', () => {
    const created = intent();
    const base64 = buildPaymentTransaction(created, BLOCKHASH);
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));

    // One length byte plus one empty signature slot, then the message.
    const decoded = decodeMessage(bytes.subarray(1 + 64));
    expect(decoded.accountKeys).toContain(created.reference);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
  });

  it('keeps the reference read-only and unsigned', () => {
    const created = intent();
    const message = buildPaymentMessage(created, BLOCKHASH);
    const index = message.accountKeys.indexOf(created.reference);
    const size = message.accountKeys.length;

    expect(index).toBeGreaterThanOrEqual(message.numRequiredSignatures);
    expect(index).toBeGreaterThanOrEqual(size - message.numReadonlyUnsignedAccounts);
  });
});
