import type { PoolState } from '@probatio/sim';
import { LayoutError } from './layout';
import { PUMP_PROGRAM_ID, bondingCurveAddress, decodeBondingCurve } from './pumpfun';
import { RpcClient } from './rpc';
import { decodeMintDecimals } from './token';

/**
 * Resolving a mint to a quotable pool.
 *
 * A pump.fun token moves venue partway through its life: it prices on a bonding
 * curve until the curve completes, then trades on PumpSwap. That migration is
 * modelled here as a first-class outcome rather than an error, because it will
 * happen to positions people are holding, mid-session, and the reader has to
 * say plainly which venue a quote came from.
 */

export type Venue =
  | { readonly kind: 'pumpfun-curve'; readonly curveAddress: string }
  | { readonly kind: 'graduated'; readonly curveAddress: string };

export interface Resolution {
  readonly mint: string;
  readonly venue: Venue;
  /** Null when the token has graduated and the successor pool is not wired up yet. */
  readonly pool: PoolState | null;
  readonly slot: number;
}

/**
 * pump.fun's fee is no longer a fixed constant on the Global account — it is
 * computed per trade by a separate fee program, and varies with the token's
 * configuration.
 *
 * This value is therefore an approximation and is explicitly *not* good enough
 * for the fill engine. Step D9 has to read the real fee rather than inherit
 * this. Carrying it as a named constant with this comment attached is the point:
 * a bare `100` in the code would have been forgotten.
 */
export const PUMPFUN_APPROXIMATE_FEE_BPS = 100;

export class PoolReader {
  readonly #rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.#rpc = rpc;
  }

  /**
   * Read the current pool state for a pump.fun mint.
   *
   * The curve and the mint are fetched in one batched call so both reflect the
   * same slot. Fetching them separately would let the decimals and the reserves
   * come from different points in time — harmless in practice, but this whole
   * package exists to remove "harmless in practice" from the fill path.
   */
  async readPumpFun(mint: string): Promise<Resolution> {
    const curveAddress = bondingCurveAddress(mint);
    const [curveAccount, mintAccount] = await this.#rpc.getAccounts([curveAddress, mint]);

    if (!curveAccount) {
      throw new LayoutError(
        `no bonding curve at ${curveAddress} — ${mint} is not a pump.fun token, or was never launched`,
      );
    }
    if (curveAccount.owner !== PUMP_PROGRAM_ID) {
      throw new LayoutError(
        `account at ${curveAddress} is owned by ${curveAccount.owner}, not the pump program`,
      );
    }
    if (!mintAccount) {
      throw new LayoutError(`mint ${mint} does not exist`);
    }

    const curve = decodeBondingCurve(curveAccount.data);
    const tokenDecimals = decodeMintDecimals(mintAccount.data);
    const slot = curveAccount.slot;

    if (curve.complete) {
      // The curve has graduated. Quoting against its final reserves would price
      // a market that is no longer trading, so this reports the migration
      // instead of returning a stale pool.
      return {
        mint,
        venue: { kind: 'graduated', curveAddress },
        pool: null,
        slot,
      };
    }

    return {
      mint,
      venue: { kind: 'pumpfun-curve', curveAddress },
      pool: {
        mint,
        solReserve: curve.virtualSolReserves,
        tokenReserve: curve.virtualTokenReserves,
        deliverableTokens: curve.realTokenReserves,
        tokenDecimals,
        feeBps: PUMPFUN_APPROXIMATE_FEE_BPS,
        source: 'pumpfun-curve',
        slot,
      },
      slot,
    };
  }
}
