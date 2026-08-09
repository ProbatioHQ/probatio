import 'server-only';
import { PoolReader, RpcClient } from '@probatio/pools';
import { PRICE_SCALE, priceFromReserves } from '@probatio/candles';
import { leaderboardRows, type LeaderboardRow } from '@probatio/db';
import { rankSeason, type RankedStanding } from '@probatio/scoring';
import type { Client } from '@libsql/client';
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
  };
}

/** Drops the cached board. For tests and for after a trade lands. */
export function clearBoardCache(seasonId?: number): void {
  if (seasonId === undefined) cache.clear();
  else cache.delete(seasonId);
}
