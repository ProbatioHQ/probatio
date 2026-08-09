import type { PoolState } from '@probatio/sim';
import { LayoutError } from './layout';
import { PUMP_PROGRAM_ID, bondingCurveAddress, decodeBondingCurve } from './pumpfun';
import { PUMPFUN_CURVE_FEES, PUMPSWAP_DEFAULT_FEES } from './fees';
import {
  POOL_OFFSETS,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  decodePumpSwapPool,
  type PumpSwapPool,
} from './pumpswap';
import { RpcClient } from './rpc';
import { decodeMintDecimals, decodeTokenAccount } from './token';

/**
 * Resolving a mint to a quotable pool.
 *
 * A pump.fun token changes venue partway through its life: it prices on a
 * bonding curve until the curve completes, then trades on PumpSwap. That
 * migration is modelled here as a first-class outcome rather than an error,
 * because it happens to positions people are holding, mid-session, and the
 * reader has to say plainly which venue a quote came from.
 */

export type Venue =
  | { readonly kind: 'pumpfun-curve'; readonly curveAddress: string }
  | { readonly kind: 'pumpswap'; readonly poolAddress: string; readonly graduated: true }
  | { readonly kind: 'unlisted' };

export interface Resolution {
  readonly mint: string;
  readonly venue: Venue;
  /** Null only when the token has graduated and no successor pool could be found. */
  readonly pool: PoolState | null;
  readonly slot: number;
}

export class PoolReader {
  readonly #rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.#rpc = rpc;
  }

  /**
   * Resolve a pump.fun mint to whichever venue is currently trading it.
   *
   * Follows the token across graduation without the caller having to know which
   * side of it they are on.
   */
  async resolve(mint: string): Promise<Resolution> {
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

    if (!curve.complete) {
      return {
        mint,
        venue: { kind: 'pumpfun-curve', curveAddress },
        pool: {
          mint,
          solReserve: curve.virtualSolReserves,
          tokenReserve: curve.virtualTokenReserves,
          // A curve prices against virtual reserves but can only hand over the
          // real ones, so a large buy is capped below what the curve alone
          // suggests.
          deliverableTokens: curve.realTokenReserves,
          tokenDecimals,
          fees: PUMPFUN_CURVE_FEES,
          source: 'pumpfun-curve',
          slot: curveAccount.slot,
        },
        slot: curveAccount.slot,
      };
    }

    // Graduated. Quoting the curve's final reserves would price a market that
    // has stopped trading, so the successor pool has to be found instead.
    const pools = await this.findPumpSwapPools(mint);
    const pool = pools[0];
    if (!pool) {
      return { mint, venue: { kind: 'unlisted' }, pool: null, slot: curveAccount.slot };
    }

    const state = await this.readPumpSwapReserves(pool.address, pool.pool, tokenDecimals);
    return {
      mint,
      venue: { kind: 'pumpswap', poolAddress: pool.address, graduated: true },
      pool: state,
      slot: state.slot,
    };
  }

  /**
   * Find the PumpSwap pools quoting a mint against SOL.
   *
   * A pool's address derives from its creator, which differs per pool and is
   * not knowable in advance, so the mint is matched inside the account data
   * instead of being derived.
   */
  async findPumpSwapPools(
    baseMint: string,
  ): Promise<{ address: string; pool: PumpSwapPool }[]> {
    const accounts = await this.#rpc.getProgramAccounts(PUMPSWAP_PROGRAM_ID, [
      { kind: 'memcmp', offset: POOL_OFFSETS.baseMint, base58: baseMint },
      { kind: 'memcmp', offset: POOL_OFFSETS.quoteMint, base58: WSOL_MINT },
    ]);

    return accounts
      .map((entry) => {
        try {
          return { address: entry.address, pool: decodePumpSwapPool(entry.account.data) };
        } catch {
          // Another account type in the same program matched the filters.
          return null;
        }
      })
      .filter((entry): entry is { address: string; pool: PumpSwapPool } => entry !== null);
  }

  /**
   * Read a PumpSwap pool's reserves.
   *
   * Both vaults are fetched in one batched call so the two balances come from
   * the same slot. Reading them separately would produce a pair of reserves
   * that never coexisted, and every quote against that pair would be against a
   * market that never existed.
   */
  async readPumpSwapReserves(
    poolAddress: string,
    pool: PumpSwapPool,
    tokenDecimals?: number,
  ): Promise<PoolState> {
    const addresses = [pool.baseVault, pool.quoteVault];
    if (tokenDecimals === undefined) addresses.push(pool.baseMint);

    const [baseAccount, quoteAccount, mintAccount] = await this.#rpc.getAccounts(addresses);

    if (!baseAccount || !quoteAccount) {
      throw new LayoutError(`pool ${poolAddress} references a vault that does not exist`);
    }

    const base = decodeTokenAccount(baseAccount.data);
    const quote = decodeTokenAccount(quoteAccount.data);

    // The vaults must belong to this pool and hold the mints it claims. If an
    // offset were wrong these would be unrelated accounts, and the reserves
    // would be someone else's balances.
    if (base.mint !== pool.baseMint || quote.mint !== pool.quoteMint) {
      throw new LayoutError(
        `pool ${poolAddress} vaults hold the wrong mints — the layout is probably wrong`,
      );
    }
    if (base.owner !== poolAddress || quote.owner !== poolAddress) {
      throw new LayoutError(
        `pool ${poolAddress} vaults are not owned by the pool — the layout is probably wrong`,
      );
    }

    const decimals =
      tokenDecimals ?? (mintAccount ? decodeMintDecimals(mintAccount.data) : undefined);
    if (decimals === undefined) {
      throw new LayoutError(`could not read decimals for ${pool.baseMint}`);
    }

    return {
      mint: pool.baseMint,
      solReserve: quote.amount,
      tokenReserve: base.amount,
      // An AMM holds its reserves outright, so everything in the vault is
      // deliverable. Only a bonding curve splits the two.
      deliverableTokens: base.amount,
      tokenDecimals: decimals,
      fees: PUMPSWAP_DEFAULT_FEES,
      source: 'pumpswap',
      slot: baseAccount.slot,
    };
  }

  /** @deprecated Use {@link resolve}, which follows the token across graduation. */
  async readPumpFun(mint: string): Promise<Resolution> {
    return this.resolve(mint);
  }
}
