import { LayoutError, discriminatorMatches, readPubkey, readU16, readU64, readU8 } from './layout';

/** The PumpSwap AMM program — where pump.fun tokens trade after graduation. */
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Wrapped SOL, the quote side of every pump.fun pool. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * PumpSwap Pool account layout, confirmed against live mainnet pools.
 *
 *   0x00  discriminator             8 bytes
 *   0x08  pool_bump                 u8
 *   0x09  index                     u16
 *   0x0b  creator                   Pubkey
 *   0x2b  base_mint                 Pubkey
 *   0x4b  quote_mint                Pubkey
 *   0x6b  lp_mint                   Pubkey
 *   0x8b  pool_base_token_account   Pubkey
 *   0xab  pool_quote_token_account  Pubkey
 *   0xcb  lp_supply                 u64
 *   0xd3  coin_creator              Pubkey
 *
 * Note what is *not* here: the reserves. A pool records the addresses of its
 * two vaults, and the balances live in those ordinary SPL token accounts. That
 * is the structural difference from a bonding curve, which carries its reserves
 * inline, and it is why reading an AMM always takes two hops.
 */
export const POOL_OFFSETS = {
  poolBump: 0x08,
  index: 0x09,
  creator: 0x0b,
  baseMint: 0x2b,
  quoteMint: 0x4b,
  lpMint: 0x6b,
  baseVault: 0x8b,
  quoteVault: 0xab,
  lpSupply: 0xcb,
  coinCreator: 0xd3,
} as const;

export const POOL_MIN_BYTES = POOL_OFFSETS.coinCreator + 32;

/** Anchor discriminator for the Pool account, taken from live mainnet pools. */
export const POOL_DISCRIMINATOR = Uint8Array.from([
  0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc,
]);

export interface PumpSwapPool {
  readonly poolBump: number;
  readonly index: number;
  readonly creator: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly lpMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly lpSupply: bigint;
  readonly coinCreator: string;
}

export function decodePumpSwapPool(data: Uint8Array): PumpSwapPool {
  if (data.length < POOL_MIN_BYTES) {
    throw new LayoutError(
      `pumpswap pool account is ${data.length} bytes, expected at least ${POOL_MIN_BYTES}`,
    );
  }
  if (!discriminatorMatches(data, POOL_DISCRIMINATOR)) {
    throw new LayoutError('account discriminator is not Pool — this is a different account type');
  }

  const o = POOL_OFFSETS;
  const pool: PumpSwapPool = {
    poolBump: readU8(data, o.poolBump),
    index: readU16(data, o.index),
    creator: readPubkey(data, o.creator),
    baseMint: readPubkey(data, o.baseMint),
    quoteMint: readPubkey(data, o.quoteMint),
    lpMint: readPubkey(data, o.lpMint),
    baseVault: readPubkey(data, o.baseVault),
    quoteVault: readPubkey(data, o.quoteVault),
    lpSupply: readU64(data, o.lpSupply),
    coinCreator: readPubkey(data, o.coinCreator),
  };

  if (pool.baseMint === pool.quoteMint) {
    throw new LayoutError('pool has the same mint on both sides — the layout is probably wrong');
  }
  if (pool.baseVault === pool.quoteVault) {
    throw new LayoutError('pool has one vault on both sides — the layout is probably wrong');
  }

  return pool;
}

/**
 * PumpSwap's fee schedule, which lives on chain rather than in this repository.
 *
 * The rates were a constant here, copied from the bonding curve's schedule, and
 * measurably wrong: 125 bps against a real cost of about 30. The comment
 * defending the copy said PumpSwap's rate slides with market cap so no single
 * number could be right, and used the high end deliberately. The premise was
 * wrong. There is one global config account and it holds three flat numbers.
 *
 * Read from mainnet, and cross-checked: `scripts/measure-pumpswap-fees.mts`
 * recovers 29 bps of total cost from real swaps by arithmetic that knows
 * nothing about this account, and this account says 30. Two independent methods
 * on the same number is the standard the curve schedule was already held to.
 *
 *   0x000  discriminator                     8 bytes
 *   0x008  admin                             Pubkey
 *   0x028  lp_fee_basis_points               u64   (20)
 *   0x030  protocol_fee_basis_points         u64   (5)
 *   0x038  protocol_fee_recipients           Pubkey[8]
 *   0x138  disable_flags                     u8
 *   0x139  coin_creator_fee_basis_points     u64   (5)
 *
 * The recipient array is what pushes the creator fee off an eight-byte
 * boundary, which is why it is at 0x139 and not 0x138.
 */
export const PUMPSWAP_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';

export const GLOBAL_CONFIG_OFFSETS = {
  admin: 0x008,
  lpFeeBasisPoints: 0x028,
  protocolFeeBasisPoints: 0x030,
  disableFlags: 0x138,
  coinCreatorFeeBasisPoints: 0x139,
} as const;

export const GLOBAL_CONFIG_MIN_BYTES = GLOBAL_CONFIG_OFFSETS.coinCreatorFeeBasisPoints + 8;

/** Anchor discriminator for GlobalConfig, taken from the live account. */
export const GLOBAL_CONFIG_DISCRIMINATOR = Uint8Array.from([
  0x95, 0x08, 0x9c, 0xca, 0xa0, 0xfc, 0xb0, 0xd9,
]);

export interface PumpSwapGlobalConfig {
  readonly admin: string;
  readonly lpFeeBps: number;
  readonly protocolFeeBps: number;
  readonly coinCreatorFeeBps: number;
}

export function decodePumpSwapGlobalConfig(data: Uint8Array): PumpSwapGlobalConfig {
  if (data.length < GLOBAL_CONFIG_MIN_BYTES) {
    throw new LayoutError(
      `pumpswap global config is ${data.length} bytes, expected at least ${GLOBAL_CONFIG_MIN_BYTES}`,
    );
  }
  if (!discriminatorMatches(data, GLOBAL_CONFIG_DISCRIMINATOR)) {
    throw new LayoutError(
      'account discriminator is not GlobalConfig — this is a different account type',
    );
  }

  const o = GLOBAL_CONFIG_OFFSETS;
  const config: PumpSwapGlobalConfig = {
    admin: readPubkey(data, o.admin),
    lpFeeBps: Number(readU64(data, o.lpFeeBasisPoints)),
    protocolFeeBps: Number(readU64(data, o.protocolFeeBasisPoints)),
    coinCreatorFeeBps: Number(readU64(data, o.coinCreatorFeeBasisPoints)),
  };

  // A misread offset produces enormous numbers rather than plausible ones, so
  // this is the check that a layout change is noticed instead of quoted. A fee
  // above 10% is not a fee PumpSwap charges; it is a field that moved.
  for (const [name, value] of [
    ['lp', config.lpFeeBps],
    ['protocol', config.protocolFeeBps],
    ['coin creator', config.coinCreatorFeeBps],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000) {
      throw new LayoutError(
        `pumpswap ${name} fee reads ${value} bps, which is not a fee — the layout has moved`,
      );
    }
  }

  return config;
}
