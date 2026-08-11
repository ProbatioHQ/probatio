/**
 * @probatio/payments — the transaction a user signs, and what actually landed.
 *
 * Two halves that must not be confused. Building a transaction is a statement
 * of intent and is worth nothing on its own; verification reads the chain and
 * is the only thing that may credit anybody. Nothing here trusts a client's
 * account of what it did.
 */

export {
  MEMO_PROGRAM_ID,
  MessageError,
  SYSTEM_PROGRAM_ID,
  compileMessage,
  decodeCompactU16,
  decodeMessage,
  decodePubkey,
  encodeCompactU16,
  encodeMessage,
  encodePubkey,
  memoInstruction,
  orderAccounts,
  serializeUnsigned,
  transferInstruction,
} from './message';
export type { AccountMeta, CompiledInstruction, Instruction, Message } from './message';

export {
  DEFAULT_TTL_MS,
  buildPaymentMessage,
  buildPaymentMessageBase58,
  buildPaymentTransaction,
  createIntent,
} from './intent';
export type { CreateIntentInput, PaymentIntent, Purpose } from './intent';

export { explainFailure, verifyPayment } from './verify';
export type { Expectation, Verification, VerificationFailure } from './verify';

export { LAMPORTS_PER_SOL, PRACTICE_TIERS, creditFor, pricePerSol, tierFor } from './store';
export type { PracticeTier } from './store';
