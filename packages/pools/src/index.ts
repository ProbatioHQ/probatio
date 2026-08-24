/**
 * @probatio/pools — venue account decoding and pool state normalization.
 *
 * Decoders are pure functions over bytes and are tested against fixtures
 * captured from mainnet. Only `RpcClient` touches the network.
 */

export {
  DISCRIMINATOR_BYTES,
  LayoutError,
  PUBKEY_BYTES,
  discriminatorMatches,
  readBool,
  readDiscriminator,
  readPubkey,
  readU8,
  readU16,
  readU64,
} from './layout';

export { findProgramAddress, pubkeySeed, utf8Seed } from './pda';
export type { DerivedAddress } from './pda';

export {
  BONDING_CURVE_MIN_BYTES,
  BONDING_CURVE_OFFSETS,
  PUMPFUN_TOKEN_DECIMALS,
  PUMPFUN_TOKEN_TOTAL_SUPPLY,
  PUMP_PROGRAM_ID,
  bondingCurveAddress,
  decodeBondingCurve,
} from './pumpfun';
export type { BondingCurveAccount } from './pumpfun';

export {
  MINT_ACCOUNT_BYTES,
  MINT_DECIMALS_OFFSET,
  TOKEN_ACCOUNT_BYTES,
  TOKEN_ACCOUNT_OFFSETS,
  decodeMintDecimals,
  decodeTokenAccount,
} from './token';
export type { TokenAccount, TokenAccountState } from './token';

export {
  GLOBAL_CONFIG_DISCRIMINATOR,
  GLOBAL_CONFIG_MIN_BYTES,
  GLOBAL_CONFIG_OFFSETS,
  PROTOCOL_FEE_RECIPIENT_SLOTS,
  POOL_DISCRIMINATOR,
  POOL_MIN_BYTES,
  POOL_WITH_OFFSET_BYTES,
  POOL_OFFSETS,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  decodePumpSwapGlobalConfig,
  decodePumpSwapPool,
  pumpSwapReserveOffset,
} from './pumpswap';
export type { PumpSwapGlobalConfig, PumpSwapPool } from './pumpswap';

export {
  BPF_UPGRADEABLE_LOADER,
  LOADER_VARIANTS,
  decodeProgramData,
  programDataAddress,
} from './upgradeable';
export type { ProgramDataAccount } from './upgradeable';

export { RpcClient, RpcError } from './rpc';
export { RpcGovernor, creditsFor, governorFor, governorStats, resetGovernors } from './governor';
export type { GovernorStats, RpcPriority } from './governor';
export type {
  AccountData,
  ConfirmedTransaction,
  ProgramAccountFilter,
  RpcOptions,
  SignatureInfo,
  TokenBalanceChange,
  TransactionLogs,
} from './rpc';

export { holderCount } from './holders';
export type { HolderCount } from './holders';
export { launchBundle } from './bundle';
export type { LaunchBundle } from './bundle';
export { PoolReader, forgetPool } from './reader';
export { PUMPFUN_CURVE_FEES, PUMPSWAP_DEFAULT_FEES } from './fees';
export type { Resolution, Venue } from './reader';

export {
  CREATE_EVENT_DISCRIMINATOR,
  decodeCreateEvent,
  extractCreateEvents,
  TRADE_EVENT_DISCRIMINATOR,
  TRADE_EVENT_MIN_BYTES,
  TRADE_EVENT_OFFSETS,
  decodeTradeEvent,
  extractTradeEvents,
} from './events';
export type { CreateEvent, TradeEvent } from './events';
