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

export { RpcClient, RpcError } from './rpc';
export type { AccountData, RpcOptions } from './rpc';

export { PUMPFUN_APPROXIMATE_FEE_BPS, PoolReader } from './reader';
export type { Resolution, Venue } from './reader';
