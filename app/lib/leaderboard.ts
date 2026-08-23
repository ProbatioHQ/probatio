import 'server-only';
import { PoolReader, RpcClient } from '@probatio/pools';
import { PRICE_SCALE, priceFromReserves } from '@probatio/candles';
import {
  allTimeRows,
  lastPrices,
  leaderboardRows,
  type AllTimeRow,
  type LeaderboardRow,
} from '@probatio/db';
import { rankSeason, type RankedStanding } from '@probatio/scoring';
import type { Client } from '@libsql/client';
import { PRACTICE_TIERS, creditFor } from '@probatio/payments';
import { rpcEndpoint } from './env';

/**
 * The standings, marked to the market.
 *
 * Two things make this affordable. Prices are read once per distinct mint
 * rather than once per trader holding it — five hundred traders in the same
 * token is one read, not five hundred — and the whole board is cached for a
 * short while, because a leaderboard that re-reads the chain on every page view
 * is a leaderboard that stops working exactly when people start watching it.
 *
 * A token whose price cannot be read is held at cost rather than marked to
 * zero. Wiping somebody's position because an RPC call failed would invent a
 * result, and this is the number that decides who gets paid.
 */

export interface Board {
  readonly standings: readonly RankedStanding[];
  readonly markedAt: number;
  /** Mints whose price could not be read; those positions are held at cost. */
  readonly unpriced: readonly string[];
}

/** Long enough to absorb a crowd, short enough that the board still moves. */
const CACHE_MS = 20_000;

const cache = new Map<number, { board: Board; expiresAt: number }>();

export async function seasonBoard(
  client: Client,
  seasonId: number,
  now: number,
): Promise<Board> {
  const cached = cache.get(seasonId);
  if (cached && cached.expiresAt > now) return cached.board;

  const rows = await leaderboardRows(client, seasonId);
  const mints = [...new Set(rows.flatMap((row) => row.positions.map((held) => held.mint)))];

  const prices = new Map<string, bigint>();
  const unpriced: string[] = [];

  if (mints.length > 0) {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 15_000, minIntervalMs: 60 });
    const reader = new PoolReader(rpc);

    await Promise.all(
      mints.map(async (mint) => {
        try {
          const resolution = await reader.resolve(mint);
          if (!resolution.pool) {
            unpriced.push(mint);
            return;
          }
          prices.set(
            mint,
            priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
          );
        } catch {
          unpriced.push(mint);
        }
      }),
    );
  }

  const board: Board = {
    standings: rankSeason(rows.map((row) => toStanding(row, prices))),
    markedAt: now,
    unpriced,
  };

  cache.set(seasonId, { board, expiresAt: now + CACHE_MS });
  return board;
}

function toStanding(row: LeaderboardRow, prices: ReadonlyMap<string, bigint>) {
  let positionValue = 0n;
  for (const held of row.positions) {
    const price = prices.get(held.mint);
    positionValue +=
      price === undefined
        ? // Held at cost: unreadable is not worthless.
          BigInt(held.costBasis)
        : (BigInt(held.tokenAmount) * price) / PRICE_SCALE;
  }

  return {
    trader: row.userPubkey,
    enteredAt: row.enteredAt,
    startingBalance: BigInt(row.startingBalance),
    finalEquity: BigInt(row.solBalance) + positionValue,
    tradeCount: row.tradeCount,
    automatedTrades: row.automatedTrades,
  };
}

/** Drops the cached board. For tests and for after a trade lands. */
export function clearBoardCache(seasonId?: number): void {
  if (seasonId === undefined) cache.clear();
  else cache.delete(seasonId);
  // The all-time board covers every season, so any trade invalidates it.
  allTimeCache = null;
}

/**
 * Everybody who has ever traded here, ranked together.
 *
 * The season board answers "who is winning the season". This answers "who
 * trades here", which is the question a visitor is actually asking when they
 * look at a leaderboard, and the one a site with fifteen traders and a
 * one-row board was answering badly.
 *
 * Ranked on return, which needs the store accounted for. Buying practice SOL
 * adds to the balance and not to the starting balance, so the naive return puts
 * whoever spent the most at the top. The credit is recomputed from the price
 * paid, using the same tier table the settlement uses, and added to the
 * denominator. Somebody who buys ten SOL and turns it into eleven is up ten
 * percent, not up a hundred and ten.
 */
export interface AllTimeStanding {
  readonly trader: string;
  readonly seasonName: string;
  readonly ranked: boolean;
  readonly startingBalance: string;
  readonly equity: string;
  readonly returnBps: number;
  readonly tradeCount: number;
  readonly automatedTrades: number;
}

export interface AllTimeBoard {
  readonly standings: readonly AllTimeStanding[];
  readonly markedAt: number;
  readonly unpriced: readonly string[];
}

/** How long the board will wait for chain prices before showing what it has. */
const PRICE_BUDGET_MS = 4_000;
/**
 * How old a stored price may be and still be used for marking.
 *
 * Twenty minutes. Long enough that a token nobody has opened lately still marks
 * against something real, short enough that a position is never carried at a
 * price from another day. Older than this falls through to the chain read.
 */
const PRICE_STALE_SECONDS = 20 * 60;

let allTimeCache: { board: AllTimeBoard; expiresAt: number } | null = null;

/** What a payment of this many lamports bought, in practice SOL. */
function creditedFor(paidLamports: bigint): bigint {
  if (paidLamports <= 0n) return 0n;
  // Summed across purchases, so an exact tier match is only expected for a
  // single one. Falling back to the per-SOL rate of the cheapest tier keeps a
  // stacked total honest rather than silently crediting nothing.
  const exact = PRACTICE_TIERS.find((tier) => tier.priceLamports === paidLamports);
  if (exact) return creditFor(exact);

  let credited = 0n;
  let left = paidLamports;
  // Largest first, because the tiers are cheaper per SOL as they grow and this
  // should not credit somebody more than their money could have bought.
  for (const tier of [...PRACTICE_TIERS].sort((a, b) => (b.priceLamports > a.priceLamports ? 1 : -1))) {
    while (left >= tier.priceLamports) {
      left -= tier.priceLamports;
      credited += creditFor(tier);
    }
  }
  return credited;
}

function toAllTime(row: AllTimeRow, prices: ReadonlyMap<string, bigint>): AllTimeStanding {
  let positionValue = 0n;
  for (const held of row.positions) {
    const price = prices.get(held.mint);
    positionValue +=
      price === undefined
        ? BigInt(held.costBasis)
        : (BigInt(held.tokenAmount) * price) / PRICE_SCALE;
  }

  const equity = BigInt(row.solBalance) + positionValue;
  const basis = BigInt(row.startingBalance) + creditedFor(BigInt(row.purchasedBalance));
  const returnBps = basis === 0n ? 0 : Number(((equity - basis) * 10_000n) / basis);

  return {
    trader: row.userPubkey,
    seasonName: row.seasonName,
    // Free play is not a competition, and a board mixing the two should say
    // which is which rather than implying they were run under the same rules.
    ranked: row.seasonOrdinal > 0,
    startingBalance: basis.toString(),
    equity: equity.toString(),
    returnBps,
    tradeCount: row.tradeCount,
    automatedTrades: row.automatedTrades,
  };
}

export async function allTimeBoard(client: Client, now: number): Promise<AllTimeBoard> {
  if (allTimeCache && allTimeCache.expiresAt > now) return allTimeCache.board;

  const rows = await allTimeRows(client);
  const mints = [...new Set(rows.flatMap((row) => row.positions.map((held) => held.mint)))];

  const prices = new Map<string, bigint>();
  const unpriced: string[] = [];

  /*
   * Stored prices first, and they are almost always the whole answer.
   *
   * Reading the chain for every held token does not finish. Fourteen accounts
   * holding twenty-nine tokens is twenty-nine pool resolutions of several round
   * trips each, against a four second budget, sharing an endpoint with the
   * wallet walker and the chart warmer. All twenty-nine came back unpriced, so
   * every position was marked at cost and every row read exactly what it
   * started with however it had traded. A board that cannot move is not a
   * board.
   *
   * The candles on disk are the same number, already paid for, in one query
   * that cannot time out. The chain read below is now the fallback for
   * whatever has no candle rather than the first thing tried.
   */
  const stored = await lastPrices(client, mints, Math.floor(now / 1_000) - PRICE_STALE_SECONDS);
  for (const [mint, close] of stored) prices.set(mint, BigInt(close));

  const missing = mints.filter((mint) => !prices.has(mint));

  if (missing.length > 0) {
    // Interactive despite being a sweep: somebody is looking at this page. It
    // already gives up after four seconds and marks the rest at cost, and
    // queueing it behind the warmers would make that the usual outcome rather
    // than the unusual one.
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 6_000, minIntervalMs: 60 });
    const reader = new PoolReader(rpc);

    /*
     * Priced on a deadline, because a board is read and a price is a detail.
     *
     * The season board can afford to wait: its equity decides who gets paid.
     * This one exists so a visitor can see who trades here, and a page that
     * says "Loading" for fifteen seconds while a rate limited endpoint is
     * retried has already failed at that, whatever it eventually shows.
     *
     * Whatever misses the deadline is held at cost and named in `unpriced`, so
     * a reader can tell a flat board from a board that could not be read.
     */
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, PRICE_BUDGET_MS));
    const pricing = missing.map(async (mint) => {
      try {
        const resolution = await reader.resolve(mint);
        if (!resolution.pool) {
          unpriced.push(mint);
          return;
        }
        prices.set(mint, priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve));
      } catch {
        // Held at cost rather than dropped: unreadable is not worthless.
        unpriced.push(mint);
      }
    });

    await Promise.race([Promise.all(pricing), deadline]);
    for (const mint of missing) {
      if (!prices.has(mint) && !unpriced.includes(mint)) unpriced.push(mint);
    }
  }

  const board: AllTimeBoard = {
    standings: rows
      /*
       * Only accounts that have actually filled something.
       *
       * An account exists from the first authenticated request, so signing in
       * and never trading used to put a row on the board at plus nothing with
       * zero trades. The page says "everybody who trades here" and the code did
       * not mean it, which is a small lie that gets less small as more people
       * sign in to look around.
       */
      .filter((row) => row.tradeCount > 0)
      .map((row) => toAllTime(row, prices))
      .sort((a, b) => b.returnBps - a.returnBps),
    markedAt: now,
    unpriced,
  };

  allTimeCache = { board, expiresAt: now + CACHE_MS };
  return board;
}
