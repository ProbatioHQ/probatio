/**
 * @probatio/auth — Sign-In With Solana.
 *
 * A wallet is the only identity in this system. There is no email, no password
 * and no account recovery, because there is no account to recover: the user is
 * the keypair.
 */

export { buildSignInMessage, CHAIN_ID, MESSAGE_VERSION } from './message';
export type { Challenge } from './message';

export { AuthError, decodePubkey, verifySignIn } from './verify';
export type { AuthErrorCode, VerifyInput } from './verify';

export {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionError,
  generateNonce,
  issueSession,
  readSession,
} from './session';
export type { SessionPayload } from './session';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
