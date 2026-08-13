/**
 * The fixed facts a verifier needs, and none it should take from a server.
 *
 * The program id and the seeds are what let anyone derive a record's on-chain
 * address themselves. If these came from the instance being checked, that
 * instance could name an account it controls and the comparison would prove
 * nothing. They live here, in the open, for exactly that reason.
 */

/** The default Probatio instance the read endpoints are served from. */
export const DEFAULT_API_BASE = 'https://probatio.app';

/** The on-chain program that holds the records. */
export const PROGRAM_ID = 'HRGEAiqX4qw7B1fgNsR64oRAKF4QwkjkZFx9YXDFxaXA';

export const SEASON_SEED = new TextEncoder().encode('season');
export const RECORD_SEED = new TextEncoder().encode('record');

/** Anchor's account discriminator for a TraderRecord, hex. */
export const TRADER_RECORD_DISCRIMINATOR = 'f9159451b5a2ad97';
