import bs58 from 'bs58';
import {
  MessageError,
  compileMessage,
  encodeMessage,
  memoInstruction,
  serializeUnsigned,
  transferInstruction,
  type Message,
} from './message';

/**
 * What the server asks the user to sign.
 *
 * An intent is a promise about a transaction that does not exist yet. It is
 * worth nothing on its own — no balance moves because an intent was created,
 * and nothing is credited until the chain is read. It exists to make the
 * eventual transaction identifiable as *this* payment rather than any transfer
 * that happened to reach the treasury.
 *
 * The reference is what does that. It is a random 32-byte key attached to the
 * transfer as a read-only account the System program never reads. It makes the
 * payment findable on chain from the intent alone, which is the case that
 * matters: a user who signs, pays, and closes the tab before the confirmation
 * reaches us has still paid, and must not be asked to pay again.
 */

export type Purpose = 'season_entry' | 'coach_upgrade';

export interface PaymentIntent {
  readonly reference: string;
  readonly payer: string;
  readonly recipient: string;
  readonly lamports: bigint;
  readonly purpose: Purpose;
  readonly memo: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Ten minutes. Long enough to approve a prompt, short enough to be re-quoted. */
export const DEFAULT_TTL_MS = 10 * 60 * 1_000;

export interface CreateIntentInput {
  readonly payer: string;
  readonly recipient: string;
  readonly lamports: bigint;
  readonly purpose: Purpose;
  readonly seasonOrdinal?: number;
  readonly now: number;
  readonly ttlMs?: number;
  /** Injected in tests. Must return 32 unpredictable bytes. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

export function createIntent(input: CreateIntentInput): PaymentIntent {
  if (input.lamports <= 0n) {
    throw new MessageError('a payment must be for more than zero');
  }

  const random = input.randomBytes ?? defaultRandomBytes;
  const reference = bs58.encode(random(32));
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;

  // The memo is for the person reading their own wallet history later. It is
  // never trusted as verification — anyone can write anything in a memo.
  const memo =
    input.purpose === 'season_entry'
      ? `Probatio season ${input.seasonOrdinal ?? '?'} entry`
      : 'Probatio coach';

  return {
    reference,
    payer: input.payer,
    recipient: input.recipient,
    lamports: input.lamports,
    purpose: input.purpose,
    memo,
    createdAt: input.now,
    expiresAt: input.now + ttl,
  };
}

export function buildPaymentMessage(intent: PaymentIntent, recentBlockhash: string): Message {
  return compileMessage(intent.payer, recentBlockhash, [
    transferInstruction(intent.payer, intent.recipient, intent.lamports, intent.reference),
    memoInstruction(intent.memo),
  ]);
}

/**
 * The message to hand Phantom, base58 encoded.
 *
 * Phantom's `request` API takes a serialized *message* rather than a
 * transaction object, which is what lets this work without web3.js: the wallet
 * adds the signature itself, so there is no empty slot to leave room for.
 */
export function buildPaymentMessageBase58(intent: PaymentIntent, recentBlockhash: string): string {
  return bs58.encode(encodeMessage(buildPaymentMessage(intent, recentBlockhash)));
}

/** The transaction to hand a wallet, base64 encoded. */
export function buildPaymentTransaction(intent: PaymentIntent, recentBlockhash: string): string {
  const bytes = serializeUnsigned(buildPaymentMessage(intent, recentBlockhash));
  return Buffer.from(bytes).toString('base64');
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
