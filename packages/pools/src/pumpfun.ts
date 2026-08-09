import {
  LayoutError,
  PUBKEY_BYTES,
  readBool,
  discriminatorMatches,
  readPubkey,
  readU64,
} from './layout';
import { findProgramAddress, pubkeySeed, utf8Seed } from './pda';

/** The pump.fun program. */
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * BondingCurve account layout.
 *
 *   0x00  discriminator          8 bytes
 *   0x08  virtual_token_reserves u64
 *   0x10  virtual_sol_reserves   u64
 *   0x18  real_token_reserves    u64
 *   0x20  real_sol_reserves      u64
 *   0x28  token_total_supply     u64
 *   0x30  complete               bool
 *   0x31  creator                Pubkey
 *
 * Later flags (is_mayhem_mode, is_cashback_coin) sit after `creator` and are
 * read only when the account is long enough — an older account that predates
 * them is still perfectly valid and must not fail to decode.
 */
export const BONDING_CURVE_OFFSETS = {
  virtualTokenReserves: 0x08,
  virtualSolReserves: 0x10,
  realTokenReserves: 0x18,
  realSolReserves: 0x20,
  tokenTotalSupply: 0x28,
  complete: 0x30,
  creator: 0x31,
  isMayhemMode: 0x31 + PUBKEY_BYTES,
  isCashbackCoin: 0x31 + PUBKEY_BYTES + 1,
} as const;

export const BONDING_CURVE_MIN_BYTES = BONDING_CURVE_OFFSETS.creator + PUBKEY_BYTES;

/**
 * Anchor's 8-byte account discriminator for BondingCurve, taken from live
 * mainnet accounts.
 *
 * Checking it turns "this is the wrong kind of account entirely" into an
 * immediate, obvious failure instead of a set of numbers that happen to parse.
 */
export const BONDING_CURVE_DISCRIMINATOR = Uint8Array.from([
  0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60,
]);

/** pump.fun mints a fixed 1,000,000,000 supply at 6 decimals. */
export const PUMPFUN_TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;
export const PUMPFUN_TOKEN_DECIMALS = 6;

export interface BondingCurveAccount {
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly tokenTotalSupply: bigint;
  /** True once the curve has graduated. Trading then happens on PumpSwap. */
  readonly complete: boolean;
  readonly creator: string;
  readonly isMayhemMode: boolean | null;
  readonly isCashbackCoin: boolean | null;
}

export function decodeBondingCurve(data: Uint8Array): BondingCurveAccount {
  if (data.length < BONDING_CURVE_MIN_BYTES) {
    throw new LayoutError(
      `bonding curve account is ${data.length} bytes, expected at least ${BONDING_CURVE_MIN_BYTES}`,
    );
  }
  if (!discriminatorMatches(data, BONDING_CURVE_DISCRIMINATOR)) {
    throw new LayoutError(
      'account discriminator is not BondingCurve — this is a different account type',
    );
  }

  const o = BONDING_CURVE_OFFSETS;

  const account: BondingCurveAccount = {
    virtualTokenReserves: readU64(data, o.virtualTokenReserves),
    virtualSolReserves: readU64(data, o.virtualSolReserves),
    realTokenReserves: readU64(data, o.realTokenReserves),
    realSolReserves: readU64(data, o.realSolReserves),
    tokenTotalSupply: readU64(data, o.tokenTotalSupply),
    complete: readBool(data, o.complete),
    creator: readPubkey(data, o.creator),
    isMayhemMode: data.length > o.isMayhemMode ? readBool(data, o.isMayhemMode) : null,
    isCashbackCoin: data.length > o.isCashbackCoin ? readBool(data, o.isCashbackCoin) : null,
  };

  assertPlausible(account);
  return account;
}

/**
 * Sanity checks that catch a wrong layout rather than a wrong market.
 *
 * If an offset drifts — a new field lands mid-struct, say — the decoded numbers
 * do not merely become inaccurate, they become nonsense. These assertions turn
 * that into a loud failure instead of a plausible-looking price.
 *
 * A completed curve is exempt from the reserve checks. On graduation the
 * liquidity moves to the AMM and all four reserve fields are zeroed, so zero is
 * the correct reading rather than a broken one. Treating that as corruption
 * would make every graduated token undecodable — which is precisely the case
 * the reader most needs to recognise, since it happens to positions people are
 * holding.
 */
function assertPlausible(account: BondingCurveAccount): void {
  if (account.tokenTotalSupply === 0n) {
    throw new LayoutError('bonding curve reports a zero total supply — the layout is wrong');
  }

  if (account.complete) return;

  if (account.virtualTokenReserves === 0n || account.virtualSolReserves === 0n) {
    throw new LayoutError(
      'an incomplete bonding curve has a zero virtual reserve, which the constant product ' +
        'cannot support — the layout is probably wrong',
    );
  }
  if (account.realTokenReserves > account.tokenTotalSupply) {
    throw new LayoutError(
      'bonding curve holds more tokens than the total supply — the layout is probably wrong',
    );
  }
  if (account.realTokenReserves > account.virtualTokenReserves) {
    throw new LayoutError(
      'real token reserves exceed virtual reserves — the layout is probably wrong',
    );
  }
}

/** The bonding curve PDA for a mint. */
export function bondingCurveAddress(mint: string): string {
  return findProgramAddress([utf8Seed('bonding-curve'), pubkeySeed(mint)], PUMP_PROGRAM_ID).address;
}
