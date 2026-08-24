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
  sessionEpoch,
  revokeSessions,
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
  lastPrices,
  priceRange,
  readCandles,
  recordBackfill,
  rollupCandles,
  writeCandles,
} from './candles';
export type { BackfillRecord, CandleWrite, StoredCandle } from './candles';

export {
  CANDLE_KEEP,
  KEEP_BY_TIMEFRAME,
  compact,
  pruneCandles,
  pruneIdleMints,
  pruneToMintBudget,
  pruneUnusedTimeframes,
  pruneLaunches,
  prunePoolSnapshots,
  runRetention,
} from './retention';
export type { RetentionResult } from './retention';

export {
  driftHistory,
  recentDrift,
  isSuspended,
  mostTradedMints,
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
  creatorLaunchCounts,
  launchByMint,
  launchesByCreator,
  launchedAtMs,
  recentLaunches,
  recordLaunches,
  searchLaunches,
} from './launches';
export type { Launch } from './launches';

export {
  INITIAL_REAL_TOKEN_RESERVES,
  bondedLaunches,
  bondingLaunches,
  curveStatesFor,
  curvesToRefresh,
  gradsToRefresh,
  unpricedGrads,
  newLaunches,
  progressBpsFor,
  recordCurveStates,
} from './curves';
export type { CurveState, CurveWrite, LaunchWithCurve } from './curves';

export {
  createRankedSeason,
  currentRankedSeason,
  highestRankedOrdinal,
  leaderboardRows,
  seasonByOrdinal,
  seasonTotals,
} from './seasons';
export type {
  CreateSeasonInput,
  LeaderboardPosition,
  LeaderboardRow,
  SeasonTotals,
} from './seasons';

export {
  createPaymentIntent,
  enterFreeSeason,
  entriesFromFunder,
  getPaymentIntent,
  hasEntered,
  intentEvidence,
  openPaymentIntents,
  paymentsFor,
  recordIntentEvidence,
  seasonEvidence,
  settlePayment,
} from './payments';
export type {
  EntryEvidence,
  EvidenceWrite,
  IntentEvidence,
  PaymentIntentRow,
  PaymentIntentWrite,
  PaymentPurpose,
  PaymentRow,
  PaymentStatus,
  Settlement,
} from './payments';

export {
  activeName,
  claimName,
  clearName,
  nameHistory,
  nameRecord,
  namesFor,
} from './names';
export type { ClaimOutcome, DisplayName } from './names';

export { activeOn, allActivity, recordActivity } from './activity';
export type { ActivityRow } from './activity';

export { claimUpdate, pruneUpdates } from './telegram';
export {
  CODE_TTL_MS,
  claimLinkCode,
  issueLinkCode,
  linkedTelegram,
  linkedWallet,
  pruneLinkCodes,
  unlinkTelegram,
} from './telegram-links';
export type { ClaimOutcome as TelegramClaimOutcome, LinkCode } from './telegram-links';
export {
  MAX_WATCHES_PER_CHAT,
  advanceWatch,
  dropChat,
  pendingFills,
  unwatchTrader,
  watchTrader,
  watchesFor,
} from './telegram-watch';
export type { WatchRow, WatchResult, WatchedFill } from './telegram-watch';
export { closeOutage, openOutage, openOutages, outagesBetween } from './outages';
export {
  copyableSwaps,
  tokenTimeline,
  observedBoard,
  observedCoverage,
  observedTraders,
  pruneObservedSwaps,
  recordObservedSwaps,
  recordTraderWalk,
  walkCandidates,
  walkedTraderCount,
} from './observed';
export type { CopyableSwap, ObservedBoard, ObservedSwap, ObservedTrader } from './observed';
export { allTimeRows } from './seasons';
export type { AllTimeRow } from './seasons';
export {
  follow,
  followCounts,
  followedTrades,
  followerList,
  followers,
  following,
  followingList,
  isFollowing,
  markFollowersSeen,
  newFollowerCount,
  traderTrades,
  unfollow,
} from './follows';
export type { FollowCounts, FollowedTrade, FollowEntry } from './follows';
export type { OutageRow } from './outages';

export { coachReportHistory, latestCoachReport, recordCoachReport } from './coach';
export type {
  CoachReportWrite,
  ReportKind,
  StoredCoachReport,
  StoredObservation,
} from './coach';

export { ConcurrentTradeError } from './trading';
export {
  allTrades,
  ensureAccount,
  ensureFreePlaySeason,
  isRankedSeason,
  openRankedSeason,
  openPosition,
  heldMints,
  isSpent,
  openPositions,
  startOver,
  recordTrade,
  totalRealizedPnl,
  recentTrades,
  tradeHistory,
} from './trading';
export type {
  AccountRow,
  PoolSnapshotWrite,
  PositionRow,
  PositionWrite,
  SeasonRow,
  TapeRow,
  TradeRow,
  TradeSource,
  TradeWrite,
} from './trading';

export {
  claimData,
  entryPayoutSignature,
  markEntryClaimed,
  markEntryRefunded,
  markSeasonFinalized,
  markSeasonVoided,
  recordFinalization,
  recordOnChainEntry,
  recordPayout,
  seasonOnchainPubkey,
  setSeasonOnchain,
  setSeasonStatus,
} from './payout';
export type { ClaimData, FinalizedEntry, SeasonLifecycle } from './payout';

export {
  StrategyError,
  automatedTradesSince,
  mintStrategyKey,
  pruneStrategyEvents,
  ownerOfKey,
  recordStrategyEvent,
  revokeStrategyKey,
  runningStrategies,
  saveStrategy,
  staleRunningStrategies,
  startStrategy,
  stopStrategy,
  strategyEvents,
  strategyFor,
  strategyKeys,
} from './strategies';
export type {
  StrategyEvent,
  StrategyKeyRow,
  StrategyRow,
  StrategyStatus,
} from './strategies';

export { backfillTwitterHandles, socialReuseFor, twitterHandle } from './handles';

export { launchBundlesFor, recordLaunchBundle } from './bundles';
export type { LaunchBundleRow } from './bundles';

export { createTestDatabase } from './testing';
export type { TestDatabase } from './testing';
