import type { Amount } from './fixed';

/**
 * Where a pool's liquidity lives. Every venue Probatio can simulate against
 * normalizes into the same {@link PoolState} shape, so the fill engine never
 * learns which venue it is quoting.
 */
export type PoolSource = 'pumpfun-curve' | 'pumpswap' | 'raydium';

/**
 * A venue's fee, split by who receives it.
 *
 * Deliberately not a single number. pump.fun charges a protocol fee and a
 * creator fee separately, PumpSwap adds an LP fee on top, and the rates move —
 * the bonding curve's 125bp splits 95 to the protocol and 30 to the creator,
 * and PumpSwap's total slides with market cap. Collapsing that into one figure
 * would make every fee change silently unrepresentable.
 */
export interface FeeSchedule {
  readonly protocolBps: number;
  readonly creatorBps: number;
  /** Paid to liquidity providers. Zero on a bonding curve, which has none. */
  readonly lpBps: number;
}

export function totalFeeBps(fees: FeeSchedule): number {
  return fees.protocolBps + fees.creatorBps + fees.lpBps;
}

/**
 * A pool as the fill engine sees it: reserves, fee, and the slot the reading
 * came from.
 *
 * This is the single abstraction every layer above sits on. Reserve semantics
 * differ wildly between a bonding curve and a constant-product AMM, and the
 * readers in step 5 are responsible for flattening that difference before the
 * engine ever sees it.
 */
export interface PoolState {
  /** The token's mint address. */
  readonly mint: string;
  /** SOL side of the pool, in lamports. Virtual reserves included where the venue uses them. */
  readonly solReserve: Amount;
  /** Token side of the pool, in the token's base units. */
  readonly tokenReserve: Amount;
  /**
   * The most tokens the venue can actually hand over.
   *
   * A bonding curve prices against virtual reserves but can only deliver the
   * real ones, so a large buy is capped below what the curve alone would
   * suggest. An AMM has no such split and sets this equal to `tokenReserve`.
   * Collapsing the two would silently overfill every large buy on a curve.
   */
  readonly deliverableTokens: Amount;
  /** The token's decimal precision, needed to render amounts but never to compute them. */
  readonly tokenDecimals: number;
  /** What the venue charges. */
  readonly fees: FeeSchedule;
  /** Which venue this reading came from. */
  readonly source: PoolSource;
  /** The slot this state was read at. Fills are always quoted against a specific slot. */
  readonly slot: number;
}

/** Which way a trade goes. */
export type Side = 'buy' | 'sell';
