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

export {
  consumeChallenge,
  pruneExpiredChallenges,
  storeChallenge,
  upsertUser,
} from './nonces';
export type { StoredChallenge } from './nonces';

export {
  displayName,
  displaySymbol,
  getManyTokenMetadata,
  getTokenMetadata,
  recordOffchainFailure,
  recordOffchainMetadata,
  staleOffchainMints,
  upsertOnchainMetadata,
} from './metadata';
export type {
  CachedTokenMetadata,
  OffchainMetadataWrite,
  OnchainMetadataWrite,
} from './metadata';

export {
  getBackfill,
  priceRange,
  readCandles,
  recordBackfill,
  writeCandles,
} from './candles';
export type { BackfillRecord, CandleWrite, StoredCandle } from './candles';

export {
  driftHistory,
  isSuspended,
  liftSuspension,
  recordDrift,
  suspendToken,
  suspendedTokens,
} from './drift';
export type { DriftHistoryEntry, DriftObservation, DriftSeverity } from './drift';

export {
  commitHistory,
  discardIntent,
  lastConfirmedCommit,
  markAttempted,
  markConfirmed,
  markFailed,
  pendingCommits,
  recordIntent,
  uncommittedTrades,
} from './commits';
export type { CommitIntent, PendingTrade, StoredCommit } from './commits';

export {
  launchByMint,
  launchesByCreator,
  recentLaunches,
  recordLaunches,
  searchLaunches,
} from './launches';
export type { Launch } from './launches';

export {
  createRankedSeason,
  currentRankedSeason,
  highestRankedOrdinal,
  seasonByOrdinal,
  seasonTotals,
} from './seasons';
export type { CreateSeasonInput, SeasonTotals } from './seasons';

export {
  createPaymentIntent,
  getPaymentIntent,
  hasEntered,
  openPaymentIntents,
  paymentsFor,
  settlePayment,
} from './payments';
export type {
  PaymentIntentRow,
  PaymentIntentWrite,
  PaymentPurpose,
  PaymentRow,
  PaymentStatus,
  Settlement,
} from './payments';

export { coachReportHistory, latestCoachReport, recordCoachReport } from './coach';
export type {
  CoachReportWrite,
  ReportKind,
  StoredCoachReport,
  StoredObservation,
} from './coach';

export {
  allTrades,
  ensureAccount,
  ensureFreePlaySeason,
  isRankedSeason,
  openRankedSeason,
  openPosition,
  openPositions,
  recordTrade,
  totalRealizedPnl,
  tradeHistory,
} from './trading';
export type {
  AccountRow,
  PoolSnapshotWrite,
  PositionRow,
  PositionWrite,
  SeasonRow,
  TradeRow,
  TradeWrite,
} from './trading';

export { createTestDatabase } from './testing';
export type { TestDatabase } from './testing';
