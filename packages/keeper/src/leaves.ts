import type { Client } from '@libsql/client';
import { hashLeaf, toHex, type TradeLeaf } from '@probatio/commit';

/**
 * Rebuilding a trade's leaf from what was stored.
 *
 * The leaf is hashed once when the trade is written and never again, so this
 * has to reproduce it exactly — a single field read back differently produces a
 * different hash, a root nobody can match, and a record that fails to verify
 * for a trader who did nothing wrong.
 *
 * Rather than trusting that, every rebuilt leaf is checked against the hash
 * stored at the time. A mismatch stops the batch instead of committing a root
 * built from leaves that do not correspond to the trades they claim to.
 */

export class LeafMismatchError extends Error {
  constructor(
    message: string,
    readonly tradeId: number,
  ) {
    super(message);
    this.name = 'LeafMismatchError';
  }
}

export interface StoredTrade {
  readonly id: number;
  readonly sequence: number;
  readonly seasonOrdinal: number;
  readonly trader: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly fee: string;
  readonly solReserve: string;
  readonly tokenReserve: string;
  readonly deliverableTokens: string;
  readonly feeBps: number;
  readonly poolSource: 'pumpfun-curve' | 'pumpswap' | 'raydium';
  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly clickedAtSlot: number;
  readonly filledAtSlot: number;
  readonly latencyMs: number;
  readonly engineVersion: number;
  readonly createdAt: number;
  readonly leafHash: string;
}

/**
 * Load the trades in a range with everything a leaf needs.
 *
 * Joined against the pool snapshot, because the reserves a fill was quoted
 * against are part of what the leaf commits to — without them a verifier would
 * have to take our word for the price.
 */
export async function loadTrades(
  db: Client,
  seasonId: number,
  userPubkey: string,
  fromTradeId: number,
  toTradeId: number,
): Promise<StoredTrade[]> {
  const result = await db.execute({
    sql: `SELECT t.*, s.ordinal AS season_ordinal,
                 p.sol_reserve, p.token_reserve, p.deliverable_tokens, p.fee_bps
          FROM trades t
          JOIN seasons s ON s.id = t.season_id
          JOIN pool_snapshots p ON p.id = t.pool_snapshot_id
          WHERE t.season_id = ? AND t.user_pubkey = ? AND t.id BETWEEN ? AND ?
          ORDER BY t.sequence`,
    args: [seasonId, userPubkey, fromTradeId, toTradeId],
  });

  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      id: Number(row['id']),
      sequence: Number(row['sequence']),
      seasonOrdinal: Number(row['season_ordinal']),
      trader: String(row['user_pubkey']),
      mint: String(row['mint']),
      side: String(row['side']) as 'buy' | 'sell',
      solAmount: String(row['sol_amount']),
      tokenAmount: String(row['token_amount']),
      fee: String(row['fee']),
      solReserve: String(row['sol_reserve']),
      tokenReserve: String(row['token_reserve']),
      // The buy cap the engine used, stored on the snapshot. On a curve this is
      // the real token reserve, which differs from the virtual `token_reserve`;
      // reading it back from `token_reserve` (as this once did) rebuilt a leaf
      // whose hash did not match the one recorded at trade time, so no curve
      // trade could commit or verify.
      deliverableTokens: String(row['deliverable_tokens']),
      feeBps: Number(row['fee_bps']),
      poolSource: String(row['pool_source']) as StoredTrade['poolSource'],
      priceImpactBps: Number(row['price_impact_bps']),
      partial: Number(row['partial']) === 1,
      clickedAtSlot: Number(row['clicked_at_slot']),
      filledAtSlot: Number(row['filled_at_slot']),
      latencyMs: Number(row['latency_ms']),
      engineVersion: Number(row['engine_version']),
      createdAt: Number(row['created_at']),
      leafHash: String(row['leaf_hash']),
    };
  });
}

export function toLeaf(trade: StoredTrade): TradeLeaf {
  return {
    sequence: trade.sequence,
    seasonOrdinal: trade.seasonOrdinal,
    trader: trade.trader,
    mint: trade.mint,
    side: trade.side,
    solAmount: BigInt(trade.solAmount),
    tokenAmount: BigInt(trade.tokenAmount),
    feeLamports: BigInt(trade.fee),
    solReserve: BigInt(trade.solReserve),
    tokenReserve: BigInt(trade.tokenReserve),
    deliverableTokens: BigInt(trade.deliverableTokens),
    feeBps: trade.feeBps,
    poolSource: trade.poolSource,
    priceImpactBps: trade.priceImpactBps,
    partial: trade.partial,
    clickedAtSlot: trade.clickedAtSlot,
    filledAtSlot: trade.filledAtSlot,
    latencyMs: trade.latencyMs,
    engineVersion: trade.engineVersion,
    createdAt: trade.createdAt,
  };
}

/**
 * Rebuild the leaves for a batch, refusing any that do not reproduce.
 *
 * The check is the point. Committing a root over leaves that disagree with
 * what was recorded would produce a commitment to trades that never happened
 * in that form — and being unable to explain the difference later is worse
 * than the batch simply not going out.
 */
export function leavesFor(trades: readonly StoredTrade[]): TradeLeaf[] {
  return trades.map((trade) => {
    const leaf = toLeaf(trade);
    const rebuilt = toHex(hashLeaf(leaf));

    if (rebuilt !== trade.leafHash) {
      throw new LeafMismatchError(
        `trade ${trade.id} rebuilds to ${rebuilt.slice(0, 16)}… but was recorded as ` +
          `${trade.leafHash.slice(0, 16)}… — the stored trade and its commitment disagree`,
        trade.id,
      );
    }

    return leaf;
  });
}
