/**
 * @probatio/db — schema and data access.
 *
 * This package stores. It does not compute. Every monetary value is held as a
 * digit string and every calculation happens in @probatio/sim on bigints, so
 * there is no path by which SQLite's numeric types can round a balance.
 */

export { openDatabase, enforceIntegrity } from './client';
export type { Client } from './client';

export { migrate, appliedMigrations } from './migrate';
export type { AppliedMigration } from './migrate';

export {
  AmountEncodingError,
  decodeAmount,
  decodeSignedAmount,
  encodeAmount,
  encodeSignedAmount,
} from './amount';

export { FREE_PLAY_ORDINAL } from './constants';
