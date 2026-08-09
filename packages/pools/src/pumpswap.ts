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

/**
 * PumpSwap charges an LP fee, a protocol fee and a creator fee, all configured
 * on a separate account and adjustable.
 *
 * As with the bonding curve, this constant is an approximation and is not good
 * enough for the fill engine. D9 has to read the real values. It is named
 * rather than inlined so it cannot be mistaken for a settled number.
 */
export const PUMPSWAP_APPROXIMATE_FEE_BPS = 30;

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
