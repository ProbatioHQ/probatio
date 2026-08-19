/**
 * The fixed facts a verifier needs, and none it should take from a server.
 *
 * There is exactly one now. This file used to carry a Solana program id, two
 * PDA seeds and an Anchor account discriminator, so that a caller could derive
 * a record's on-chain address themselves rather than being handed one by the
 * instance under scrutiny. That reasoning was sound and the program was never
 * deployed, so what it actually shipped was an address for an account that does
 * not exist, exported from a package whose verification never reads it.
 *
 * Verification is over hashes (see verify.ts), and needs no chain constants at
 * all. They are gone rather than kept for later: a published package saying a
 * program id is what proves a record would be describing something this library
 * does not do.
 */

/**
 * The Probatio instance the read endpoints are served from by default.
 *
 * Only ever the source of the figures. Every check runs on them afterwards, on
 * the caller's machine, so pointing this at an instance you do not trust is the
 * intended use rather than a risk.
 */
export const DEFAULT_API_BASE = 'https://probatiotrade.com';
