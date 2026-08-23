import type { FeeSchedule, PoolState } from '@probatio/sim';
import { LayoutError } from './layout';
import {
  BONDING_CURVE_MIN_BYTES,
  PUMP_PROGRAM_ID,
  bondingCurveAddress,
  decodeBondingCurve,
  type BondingCurveAccount,
} from './pumpfun';
import { PUMPFUN_CURVE_FEES, PUMPSWAP_DEFAULT_FEES } from './fees';
import {
  POOL_OFFSETS,
  PUMPSWAP_GLOBAL_CONFIG,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  decodePumpSwapGlobalConfig,
  decodePumpSwapPool,
  pumpSwapReserveOffset,
  type PumpSwapGlobalConfig,
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

/** A pool with no creator to pay. Anchor writes an unset Pubkey as all zeros. */
const UNSET_CREATOR = '11111111111111111111111111111111';

/**
 * Which pool is a graduated mint's market, remembered between reads.
 *
 * WHAT IS CACHED, AND WHAT IS EMPHATICALLY NOT
 *
 * Only the *identity* of the pool: its address and its layout. The reserves are
 * read fresh on every single resolve and are never stored here, because a quote
 * against a remembered balance is a fabricated quote and the entire engine rests
 * on that not happening. This changes which account is read, never how recently.
 *
 * WHY IT EXISTS
 *
 * Finding the pool means scanning every account the PumpSwap program owns,
 * filtered by mint. There is no address to derive: a pool's key comes from its
 * creator, so the mint has to be matched inside the data. That scan is twenty
 * credits against a plain read's one, and it ran twice per fill, on both sides
 * of the latency wait. Measured: a graduated round trip cost about ninety-six
 * credits, of which eighty were the same scan answering the same question four
 * times. With the answer remembered it is about sixteen.
 *
 * WHY A SHORT LIFE
 *
 * Which pool is deepest is a live fact and a security-relevant one. `deepestPool`
 * exists because a trader who controls the pool the simulator quotes from
 * controls the price of their own fills, and the defence is that being quoted
 * costs real SOL. Remembering the winner for too long turns that into a stale
 * answer, so it is minutes rather than hours, and any read that finds the
 * remembered pool empty throws it away and searches again.
 */
const POOL_TTL_MS = 5 * 60 * 1_000;

/** Bounded: a busy feed touches thousands of mints and this is only a shortcut. */
const POOL_CACHE_MAX = 2_000;

interface CachedPool {
  readonly address: string;
  readonly pool: PumpSwapPool;
  readonly at: number;
}

/*
 * Shared across readers rather than held per instance.
 *
 * There are several readers in a running process — the request path, the house
 * accounts, the price marker — and each one pays this cost separately. They are
 * all asking the same question about the same mint, so per-instance caches would
 * answer it once each instead of once.
 */
const POOL_CACHE_KEY = Symbol.for('probatio.pumpswap-pools');

function poolCache(): Map<string, CachedPool> {
  const store = globalThis as unknown as Record<symbol, Map<string, CachedPool> | undefined>;
  const existing = store[POOL_CACHE_KEY];
  if (existing) return existing;
  const fresh = new Map<string, CachedPool>();
  store[POOL_CACHE_KEY] = fresh;
  return fresh;
}

function rememberPool(mint: string, address: string, pool: PumpSwapPool, at: number): void {
  const cache = poolCache();
  cache.delete(mint);
  cache.set(mint, { address, pool, at });
  while (cache.size > POOL_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function rememberedPool(mint: string, now: number): CachedPool | null {
  const held = poolCache().get(mint);
  if (!held) return null;
  if (now - held.at >= POOL_TTL_MS) {
    poolCache().delete(mint);
    return null;
  }
  return held;
}

/** Forget a mint's pool, so the next read searches again. Exported for tests. */
export function forgetPool(mint: string): void {
  poolCache().delete(mint);
}

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
  /** PumpSwap's published fee schedule. Read once, then reused. */
  #globalConfig: PumpSwapGlobalConfig | null = null;

  constructor(rpc: RpcClient) {
    this.#rpc = rpc;
  }

  /**
   * What PumpSwap charges, from PumpSwap.
   *
   * The rates used to be a constant in this repository, copied from the bonding
   * curve's schedule: 125 bps against a real cost of about 30. Every graduated
   * token was quoted at four times its true cost, which in a ranked season is
   * not only an accuracy problem — a trader on a migrated coin was handicapped
   * against one trading the curve, where the fee is exact, and the two are
   * ranked together for the same prize.
   *
   * The config is cached for the life of the reader. It is an administered
   * account that changes very rarely, and paying an extra round trip on every
   * quote to re-read a number that has not moved would cost latency the fill
   * model actually cares about.
   *
   * The creator fee is charged only where there is a creator to pay it to. A
   * pool whose `coinCreator` is unset has none.
   *
   * This was written that way, then changed to charge it always, then changed
   * back — and the round trip is worth recording because of what settled it.
   * The evidence for charging always was a crude measurement putting a
   * creatorless pool's cost at 29 bps, which is 20 + 5 + 5 and not 20 + 5. That
   * measurement was counting the front end's own cut as the venue's, so the
   * number was several basis points too high and pointed the wrong way.
   *
   * The replay harness settled it, which is what a harness is for: quoting the
   * creator fee on a creatorless pool leaves every single sample short by
   * exactly five basis points, and dropping it leaves them exact.
   */
  async pumpSwapFees(pool: PumpSwapPool): Promise<FeeSchedule> {
    const config = await this.globalConfig();
    if (!config) return PUMPSWAP_DEFAULT_FEES;

    return {
      protocolBps: config.protocolFeeBps,
      creatorBps: pool.coinCreator === UNSET_CREATOR ? 0 : config.coinCreatorFeeBps,
      lpBps: config.lpFeeBps,
    };
  }

  /**
   * The config account, or null if it cannot be read or understood.
   *
   * Null falls back to the old constant, and that is the safe direction on
   * purpose: 125 bps quotes a trader worse than the market, which is the
   * smaller sin. Guessing lower on a failed read would hand out fills nobody
   * could have got.
   */
  async globalConfig(): Promise<PumpSwapGlobalConfig | null> {
    if (this.#globalConfig) return this.#globalConfig;
    try {
      const [account] = await this.#rpc.getAccounts([PUMPSWAP_GLOBAL_CONFIG]);
      if (!account || account.owner !== PUMPSWAP_PROGRAM_ID) return null;
      this.#globalConfig = decodePumpSwapGlobalConfig(account.data);
      return this.#globalConfig;
    } catch {
      return null;
    }
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

    /*
     * A curve account too small to decode is a curve that is over.
     *
     * pump.fun shrinks the account once a token has graduated, and it comes
     * back as forty-nine bytes: still owned by the program, no longer holding
     * reserves. Decoding threw on it, which took out every caller in turn. The
     * chart warmer stopped mid-run, and the accounts trading through the engine
     * failed on any token that had graduated since it was picked, which on
     * pump.fun is most of the interesting ones.
     *
     * There is nothing ambiguous about the state it describes: no curve to
     * quote, so the successor pool is where trading is, exactly as for a curve
     * that reports itself complete.
     */
    let curve: BondingCurveAccount | null = null;
    try {
      curve = decodeBondingCurve(curveAccount.data);
    } catch (error) {
      if (curveAccount.data.length >= BONDING_CURVE_MIN_BYTES) throw error;
    }
    const tokenDecimals = decodeMintDecimals(mintAccount.data);

    if (curve && !curve.complete) {
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
    const now = Date.now();
    const remembered = rememberedPool(mint, now);

    if (remembered) {
      /*
       * The shortcut, and the check that keeps it honest.
       *
       * Reserves are read fresh here exactly as they are on the slow path; the
       * only thing skipped is the program scan that decides *which* pool. If the
       * remembered one has since been emptied, or has become unreadable, the
       * answer is thrown away and the full search runs. Quoting a drained pool
       * would refuse every trade on a token that is trading perfectly well
       * somewhere else, which is a worse failure than the cost this avoids.
       */
      try {
        const [poolAccount] = await this.#rpc.getAccounts([remembered.address]);
        const state = await this.readPumpSwapReserves(
          remembered.address,
          remembered.pool,
          tokenDecimals,
          poolAccount ? pumpSwapReserveOffset(poolAccount.data) : 0n,
        );
        if (state.solReserve > 0n && state.tokenReserve > 0n) {
          return {
            mint,
            venue: { kind: 'pumpswap', poolAddress: remembered.address, graduated: true },
            pool: state,
            slot: state.slot,
          };
        }
      } catch {
        // Fall through to the search below.
      }
      forgetPool(mint);
    }

    const pools = await this.findPumpSwapPools(mint);
    const pool = await this.deepestPool(pools);
    if (!pool) {
      return { mint, venue: { kind: 'unlisted' }, pool: null, slot: curveAccount.slot };
    }

    const [poolAccount] = await this.#rpc.getAccounts([pool.address]);
    const state = await this.readPumpSwapReserves(
      pool.address,
      pool.pool,
      tokenDecimals,
      poolAccount ? pumpSwapReserveOffset(poolAccount.data) : 0n,
    );
    rememberPool(mint, pool.address, pool.pool, now);
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
   * Which of a mint's pools is the market.
   *
   * Anybody may create a PumpSwap pool for any mint against WSOL, and popular
   * graduations collect a dozen. This used to take `pools[0]` — whichever the
   * RPC happened to list first, an order no node promises and which differs
   * between providers and over time.
   *
   * Measured against mainnet rather than argued about: one graduated token had
   * thirteen pools, and the one `pools[0]` selected held 0.0044 SOL while the
   * real market held 46.1 SOL. Ten thousand times shallower. Spot prices sit
   * close because arbitrage keeps them there, so the error is invisible in the
   * price and total in the fill: depth is what sets price impact, and impact is
   * most of what this engine exists to reproduce honestly. Against a pool that
   * shallow an ordinary buy either moves the price absurdly or is refused for
   * breaching the impact cap, and a graduated token is effectively untradeable.
   *
   * It is also the cheapest attack on the leaderboard there is. Creating a pool
   * costs very little, and a trader who controls the pool the simulator quotes
   * from controls the price of their own fills — which is the whole season.
   * Depth is not something an attacker can fake cheaply: to be quoted they have
   * to be the deepest market in the token, which means putting up real SOL that
   * real arbitrage will take off them.
   *
   * One batched read prices every candidate, so this costs a single extra round
   * trip rather than one per pool. Ties break on address so that two servers,
   * or the same server replaying a season, choose identically.
   */
  async deepestPool(
    pools: readonly { address: string; pool: PumpSwapPool }[],
  ): Promise<{ address: string; pool: PumpSwapPool } | null> {
    if (pools.length === 0) return null;
    if (pools.length === 1) return pools[0]!;

    // The quote vault holds the SOL side, which is the depth that matters.
    const vaults = pools.map((entry) => entry.pool.quoteVault);
    const accounts = await this.#rpc.getAccounts(vaults);

    let best: { address: string; pool: PumpSwapPool } | null = null;
    let bestReserve = -1n;

    for (const [index, entry] of pools.entries()) {
      const account = accounts[index];
      if (!account) continue;

      let reserve: bigint;
      try {
        const vault = decodeTokenAccount(account.data);
        // A vault that does not belong to this pool, or holds the wrong mint,
        // is not evidence of anything. Skipping is right: a forged pointer
        // must not be able to win the comparison.
        if (vault.owner !== entry.address || vault.mint !== entry.pool.quoteMint) continue;
        reserve = vault.amount;
      } catch {
        continue;
      }

      if (reserve > bestReserve || (reserve === bestReserve && best && entry.address < best.address)) {
        best = entry;
        bestReserve = reserve;
      }
    }

    // Every candidate unreadable. Falling back to an arbitrary one would be
    // the bug this function exists to remove, so the token reads as unlisted.
    return best;
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
    quoteReserveOffset = 0n,
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
      /*
       * Not simply the vault balance.
       *
       * Some pools price against more SOL than they hold, and the surplus is
       * recorded in the pool account. Quoting the raw vault balance on one of
       * those put the engine a constant 2.8 times away from the market — 2.8 on
       * buys and its reciprocal on sells, which is what a wrong reserve looks
       * like rather than wrong arithmetic. The offset was solved from real
       * fills before it was found in the account, and it is trusted because
       * counting it reproduces real swaps on pools it was never derived from:
       * two further ones replayed at 7,501 and 26,589 basis points of error
       * without it and at 28 with it.
       *
       * Three of five graduated pools sampled carry one, so this is the usual
       * case for a migrated coin and not a corner of it.
       *
       * The 28 basis points that remain are a degeneracy rather than a mystery.
       * These pools price against roughly 19 SOL while holding 1.5, so an
       * ordinary trade is tiny against the reserve and the quote is very nearly
       * linear — and in that regime a fee and a reserve are not separable. The
       * same fills are reproduced exactly by this offset with a 2 bps fee, or
       * by a 0.3% larger offset with the venue's real 30. Nothing here can tell
       * those apart, so the venue's published fee stays and the residual is
       * left where it errs harsh: the engine pays out slightly less than the
       * market did. Fitting a 2 bps fee to make the number pretty would be
       * inventing a rate the venue does not charge.
       */
      solReserve: quote.amount + quoteReserveOffset,
      tokenReserve: base.amount,
      // An AMM holds its reserves outright, so everything in the vault is
      // deliverable. Only a bonding curve splits the two.
      deliverableTokens: base.amount,
      tokenDecimals: decimals,
      fees: await this.pumpSwapFees(pool),
      source: 'pumpswap',
      slot: baseAccount.slot,
    };
  }

  /** @deprecated Use {@link resolve}, which follows the token across graduation. */
  async readPumpFun(mint: string): Promise<Resolution> {
    return this.resolve(mint);
  }
}
