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
  POOL_DISCRIMINATOR,
  POOL_MIN_BYTES,
  POOL_OFFSETS,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  decodePumpSwapPool,
} from './pumpswap';
export type { PumpSwapPool } from './pumpswap';

export { RpcClient, RpcError } from './rpc';
export type {
  AccountData,
  ProgramAccountFilter,
  RpcOptions,
  SignatureInfo,
  TransactionLogs,
} from './rpc';

export { PoolReader } from './reader';
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
