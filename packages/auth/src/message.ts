/**
 * The message a user signs to prove they hold a wallet.
 *
 * The client never sends this text back. The server rebuilds it from its own
 * stored challenge and verifies the signature against that reconstruction. A
 * client-supplied message would mean verifying a signature over text the
 * attacker chose, which is the classic way this flow gets broken.
 */

export interface Challenge {
  readonly pubkey: string;
  readonly nonce: string;
  readonly domain: string;
  readonly uri: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const CHAIN_ID = 'solana:mainnet' as const;
export const MESSAGE_VERSION = '1' as const;

/**
 * Deliberately plain about what signing does and does not authorise. A user
 * approving a wallet popup should be able to read one line and know their funds
 * cannot move.
 */
const STATEMENT =
  'Sign in to Probatio. This proves you control this wallet. ' +
  'It authorises no transaction and cannot move your funds.';

export function buildSignInMessage(challenge: Challenge): string {
  return [
    `${challenge.domain} wants you to sign in with your Solana account:`,
    challenge.pubkey,
    '',
    STATEMENT,
    '',
    `URI: ${challenge.uri}`,
    `Version: ${MESSAGE_VERSION}`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${new Date(challenge.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(challenge.expiresAt).toISOString()}`,
  ].join('\n');
}
