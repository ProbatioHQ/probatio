import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  buildPaymentMessage,
  buildPaymentMessageBase58,
  buildPaymentTransaction,
  createIntent,
} from '../src/intent';
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


/*
 * The bytes a wallet actually reads.
 *
 * Every other test here decodes the payload with this package's own decoder,
 * which is why they all passed while the store was unusable: the payload was a
 * bare message, our decoder reads bare messages, and it agreed with itself.
 *
 * A wallet does not. It reads what it is handed as a transaction, so byte 0 is
 * a signature count, not a header. Handed a bare message it read the leading
 * `numRequiredSignatures` of 1 as "one signature", skipped 64 bytes it believed
 * were that signature, and started parsing the message from the middle of the
 * account-key array. Whichever pubkey byte landed there became the version, and
 * Phantom refused with "Transaction message version 3 deserialization is not
 * supported" — a version number that was one byte of an address.
 *
 * So this decodes the way a wallet does, not the way we do.
 */
describe('the payload a wallet is handed', () => {
  function walletView(payload: string) {
    const bytes = bs58.decode(payload);
    const signatureCount = bytes[0]!;
    const messageStart = 1 + signatureCount * 64;
    return {
      signatureCount,
      slotsAreEmpty: bytes.slice(1, messageStart).every((byte) => byte === 0),
      firstMessageByte: bytes[messageStart]!,
    };
  }

  it('is a transaction, so byte 0 is a signature count with room after it', () => {
    const view = walletView(buildPaymentMessageBase58(intent(), BLOCKHASH));

    expect(view.signatureCount).toBe(1);
    expect(view.slotsAreEmpty).toBe(true);
  });

  it('leaves a legacy message where the wallet looks for one', () => {
    const view = walletView(buildPaymentMessageBase58(intent(), BLOCKHASH));

    // The high bit is the versioned-message marker. Set, and the wallet reports
    // a version it cannot deserialise and refuses to sign.
    expect(view.firstMessageByte & 0x80).toBe(0);
    // Clear, it is `numRequiredSignatures`, which is one: the payer.
    expect(view.firstMessageByte).toBe(1);
  });

  it('still decodes as the message it claims to be', () => {
    const bytes = bs58.decode(buildPaymentMessageBase58(intent(), BLOCKHASH));
    const message = decodeMessage(bytes.slice(1 + 64));

    expect(message.numRequiredSignatures).toBe(1);
    expect(message.accountKeys[0]).toBe(PAYER);
    expect(message.recentBlockhash).toBe(BLOCKHASH);
  });
});
