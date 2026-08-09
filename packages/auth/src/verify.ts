import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { buildSignInMessage, type Challenge } from './message';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: AuthErrorCode,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type AuthErrorCode =
  | 'malformed_pubkey'
  | 'malformed_signature'
  | 'challenge_expired'
  | 'challenge_consumed'
  | 'pubkey_mismatch'
  | 'bad_signature';

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Decode a base58 Solana address, rejecting anything that is not a valid ed25519 key length. */
export function decodePubkey(pubkey: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(pubkey);
  } catch {
    throw new AuthError('public key is not valid base58', 'malformed_pubkey');
  }
  if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new AuthError(
      `public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${bytes.length}`,
      'malformed_pubkey',
    );
  }
  return bytes;
}

function decodeSignature(signature: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(signature);
  } catch {
    throw new AuthError('signature is not valid base58', 'malformed_signature');
  }
  if (bytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new AuthError(
      `signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${bytes.length}`,
      'malformed_signature',
    );
  }
  return bytes;
}

export interface VerifyInput {
  readonly challenge: Challenge;
  /** Base58 signature produced by the wallet. */
  readonly signature: string;
  /** The pubkey the client claims signed. Must match the challenge it was issued for. */
  readonly claimedPubkey: string;
  /** Injected so tests are not at the mercy of the wall clock. */
  readonly now: number;
}

/**
 * Verify a signed challenge.
 *
 * Every check here is a way this flow has been broken somewhere before: a
 * challenge reused after expiry, a challenge issued for one wallet redeemed by
 * another, a signature over attacker-chosen text.
 */
export function verifySignIn(input: VerifyInput): void {
  const { challenge, signature, claimedPubkey, now } = input;

  if (claimedPubkey !== challenge.pubkey) {
    throw new AuthError(
      'this challenge was issued for a different wallet',
      'pubkey_mismatch',
    );
  }

  if (now >= challenge.expiresAt) {
    throw new AuthError('challenge has expired', 'challenge_expired');
  }

  const publicKey = decodePubkey(challenge.pubkey);
  const signatureBytes = decodeSignature(signature);
  const message = new TextEncoder().encode(buildSignInMessage(challenge));

  let valid: boolean;
  try {
    valid = ed25519.verify(signatureBytes, message, publicKey);
  } catch {
    valid = false;
  }

  if (!valid) {
    throw new AuthError('signature does not match this challenge', 'bad_signature');
  }
}
