import type { Client } from '@libsql/client';
import { FREE_PLAY_ORDINAL } from './constants';

/**
 * Reading and writing the state a trade changes.
 *
 * A fill touches four things: the account's balance, its position, the trade
 * log and a snapshot of the pool it was quoted against. They are written in one
 * transaction, because a balance that moved without a trade to explain it is
 * unauditable, and a trade without the reserves behind it is unverifiable.
 */

export interface AccountRow {
  readonly id: number;
  readonly seasonId: number;
  readonly seasonOrdinal: number;
  readonly userPubkey: string;
  readonly generation: number;
  readonly solBalance: string;
  readonly startingBalance: string;
  readonly latencyMs: number;
  readonly maxPriceImpactBps: number;
  readonly engineVersion: number;
}

export interface PositionRow {
  readonly id: number;
  readonly mint: string;
  readonly tokenAmount: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly openedAt: number;
}

/**
 * Free play, created on first use.
 *
 * Modelled as a season so nothing downstream has to fork on whether the trader
 * paid to be here.
 */
export async function ensureFreePlaySeason(db: Client, now: number): Promise<number> {
  const existing = await db.execute({
    sql: 'SELECT id FROM seasons WHERE ordinal = ?',
    args: [FREE_PLAY_ORDINAL],
  });
  if (existing.rows[0]) return Number(existing.rows[0]['id']);

  const created = await db.execute({
    sql: `INSERT INTO seasons
            (ordinal, name, ranked, status, starting_balance, entry_cost,
             house_bps, house_threshold, latency_ms, max_price_impact_bps,
             engine_version, scoring_formula_hash, created_at)
          VALUES (?, 'Free play', 0, 'running', '10000000000', '0',
                  0, '0', 600, 5000, 1, 'free', ?)
          RETURNING id`,
    args: [FREE_PLAY_ORDINAL, now],
  });
  return Number(created.rows[0]!['id']);
}

/** The trader's account for a season, created at the starting balance if new. */
export async function ensureAccount(
  db: Client,
  seasonId: number,
  userPubkey: string,
  now: number,
): Promise<AccountRow> {
  const season = await db.execute({
    sql: 'SELECT * FROM seasons WHERE id = ?',
    args: [seasonId],
  });
  const seasonRow = season.rows[0];
  if (!seasonRow) throw new Error(`no season ${seasonId}`);

  const existing = await db.execute({
    sql: `SELECT * FROM accounts WHERE season_id = ? AND user_pubkey = ?
          ORDER BY generation DESC LIMIT 1`,
    args: [seasonId, userPubkey],
  });

  let row = existing.rows[0];
  if (!row) {
    const created = await db.execute({
      sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?) RETURNING *`,
      args: [seasonId, userPubkey, String(seasonRow['starting_balance']), now, now],
    });
    row = created.rows[0]!;
  }

  return {
    id: Number(row['id']),
    seasonId,
    seasonOrdinal: Number(seasonRow['ordinal']),
    userPubkey,
    generation: Number(row['generation']),
    solBalance: String(row['sol_balance']),
    startingBalance: String(seasonRow['starting_balance']),
    latencyMs: Number(seasonRow['latency_ms']),
    maxPriceImpactBps: Number(seasonRow['max_price_impact_bps']),
    engineVersion: Number(seasonRow['engine_version']),
  };
}

/** The open position in a token, if any. */
export async function openPosition(
  db: Client,
  accountId: number,
  mint: string,
): Promise<PositionRow | null> {
  const result = await db.execute({
    sql: `SELECT * FROM positions WHERE account_id = ? AND mint = ? AND closed_at IS NULL
          ORDER BY opened_at DESC LIMIT 1`,
    args: [accountId, mint],
  });
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: Number(row['id']),
    mint: String(row['mint']),
    tokenAmount: String(row['token_amount']),
    costBasis: String(row['cost_basis']),
    realizedPnl: String(row['realized_pnl']),
    openedAt: Number(row['opened_at']),
  };
}

export interface TradeWrite {
  readonly accountId: number;
  readonly seasonId: number;
  readonly userPubkey: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly fee: string;
  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly poolSource: string;
  readonly clickedAtSlot: number;
  readonly filledAtSlot: number;
  readonly latencyMs: number;
  readonly engineVersion: number;
  readonly leafHash: string;
}

export interface PoolSnapshotWrite {
  readonly mint: string;
  readonly solReserve: string;
  readonly tokenReserve: string;
  readonly tokenDecimals: number;
  readonly feeBps: number;
  readonly source: string;
  readonly slot: number;
}

export interface PositionWrite {
  readonly accountId: number;
  readonly mint: string;
  readonly tokenAmount: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly closed: boolean;
}

/**
 * Write everything a fill changed, atomically.
 *
 * If any part fails the whole thing rolls back. A balance that moved without a
 * trade to explain it cannot be audited, and a trade whose pool snapshot never
 * landed cannot be verified — either would be worse than the trade simply
 * failing.
 */
export async function recordTrade(
  db: Client,
  input: {
    readonly snapshot: PoolSnapshotWrite;
    readonly trade: Omit<TradeWrite, 'poolSnapshotId' | 'leafHash'>;
    readonly position: PositionWrite;
    readonly newBalance: string;
    /**
     * Produces the leaf hash once the sequence is known.
     *
     * A callback rather than a value because the sequence is only settled
     * inside this transaction, and the leaf commits to it. Hashing beforehand
     * would mean hashing a number that had not been decided.
     */
    readonly leafHashFor: (sequence: number) => string;
    readonly now: number;
  },
): Promise<{ id: number; sequence: number }> {
  const tx = await db.transaction('write');

  try {
    // The same pool at the same slot may already be recorded by another
    // trader's fill, and two rows would be two different snapshots of one
    // moment.
    const snapshot = await tx.execute({
      sql: `INSERT INTO pool_snapshots
              (mint, sol_reserve, token_reserve, token_decimals, fee_bps, source, slot, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mint, slot) DO UPDATE SET observed_at = observed_at
            RETURNING id`,
      args: [
        input.snapshot.mint,
        input.snapshot.solReserve,
        input.snapshot.tokenReserve,
        input.snapshot.tokenDecimals,
        input.snapshot.feeBps,
        input.snapshot.source,
        input.snapshot.slot,
        input.now,
      ],
    });
    const snapshotId = Number(snapshot.rows[0]!['id']);

    // Settled here, inside the transaction, so it cannot be read by two
    // trades at once. The unique index enforces that if it ever were.
    const last = await tx.execute({
      sql: 'SELECT COALESCE(MAX(sequence), 0) AS last FROM trades WHERE account_id = ?',
      args: [input.trade.accountId],
    });
    const sequence = Number(last.rows[0]!['last']) + 1;

    const trade = await tx.execute({
      sql: `INSERT INTO trades (
              account_id, season_id, user_pubkey, mint, side, sol_amount, token_amount,
              fee, price_impact_bps, partial, pool_source, clicked_at_slot, filled_at_slot,
              latency_ms, engine_version, pool_snapshot_id, leaf_hash, sequence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id`,
      args: [
        input.trade.accountId,
        input.trade.seasonId,
        input.trade.userPubkey,
        input.trade.mint,
        input.trade.side,
        input.trade.solAmount,
        input.trade.tokenAmount,
        input.trade.fee,
        input.trade.priceImpactBps,
        input.trade.partial ? 1 : 0,
        input.trade.poolSource,
        input.trade.clickedAtSlot,
        input.trade.filledAtSlot,
        input.trade.latencyMs,
        input.trade.engineVersion,
        snapshotId,
        input.leafHashFor(sequence),
        sequence,
        input.now,
      ],
    });

    await tx.execute({
      sql: 'UPDATE accounts SET sol_balance = ?, updated_at = ? WHERE id = ?',
      args: [input.newBalance, input.now, input.trade.accountId],
    });

    const existing = await tx.execute({
      sql: `SELECT id FROM positions WHERE account_id = ? AND mint = ? AND closed_at IS NULL
            ORDER BY opened_at DESC LIMIT 1`,
      args: [input.position.accountId, input.position.mint],
    });

    if (existing.rows[0]) {
      await tx.execute({
        sql: `UPDATE positions SET token_amount = ?, cost_basis = ?, realized_pnl = ?,
                closed_at = ?, updated_at = ? WHERE id = ?`,
        args: [
          input.position.tokenAmount,
          input.position.costBasis,
          input.position.realizedPnl,
          input.position.closed ? input.now : null,
          input.now,
          Number(existing.rows[0]['id']),
        ],
      });
    } else {
      await tx.execute({
        sql: `INSERT INTO positions
                (account_id, mint, token_amount, cost_basis, realized_pnl, opened_at, closed_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.position.accountId,
          input.position.mint,
          input.position.tokenAmount,
          input.position.costBasis,
          input.position.realizedPnl,
          input.now,
          input.position.closed ? input.now : null,
          input.now,
        ],
      });
    }

    await tx.commit();
    return { id: Number(trade.rows[0]!['id']), sequence };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/** Every open position on an account. */
export async function openPositions(db: Client, accountId: number): Promise<PositionRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM positions WHERE account_id = ? AND closed_at IS NULL AND token_amount != '0'
          ORDER BY opened_at DESC`,
    args: [accountId],
  });

  return result.rows.map((row) => ({
    id: Number(row['id']),
    mint: String(row['mint']),
    tokenAmount: String(row['token_amount']),
    costBasis: String(row['cost_basis']),
    realizedPnl: String(row['realized_pnl']),
    openedAt: Number(row['opened_at']),
  }));
}

/**
 * Realized profit and loss across every position the account has ever held.
 *
 * Includes closed ones deliberately. A trader who bought well, sold and moved
 * on has realized that money, and a total drawn only from open positions would
 * show them having made nothing.
 */
export async function totalRealizedPnl(db: Client, accountId: number): Promise<string> {
  const result = await db.execute({
    sql: 'SELECT realized_pnl FROM positions WHERE account_id = ?',
    args: [accountId],
  });

  // Summed in bigint rather than SQL, because these are digit strings and
  // SQLite would coerce them through a float to add them.
  const total = result.rows.reduce(
    (sum, row) => sum + BigInt(String(row['realized_pnl'])),
    0n,
  );
  return total.toString();
}

export interface TradeRow {
  readonly id: number;
  readonly sequence: number;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly fee: string;
  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly latencyMs: number;
  readonly engineVersion: number;
  readonly leafHash: string;
  readonly createdAt: number;
}

/** The trade log, newest first. Append-only, so this is the whole story. */
export async function tradeHistory(
  db: Client,
  accountId: number,
  limit = 100,
  mint?: string,
): Promise<TradeRow[]> {
  const result = await db.execute(
    mint
      ? {
          sql: `SELECT * FROM trades WHERE account_id = ? AND mint = ?
                ORDER BY id DESC LIMIT ?`,
          args: [accountId, mint, limit],
        }
      : {
          sql: 'SELECT * FROM trades WHERE account_id = ? ORDER BY id DESC LIMIT ?',
          args: [accountId, limit],
        },
  );

  return result.rows.map((row) => toTradeRow(row as unknown as Record<string, unknown>));
}

function toTradeRow(row: Record<string, unknown>): TradeRow {
  return {
    id: Number(row['id']),
    sequence: Number(row['sequence']),
    mint: String(row['mint']),
    side: String(row['side']) as 'buy' | 'sell',
    solAmount: String(row['sol_amount']),
    tokenAmount: String(row['token_amount']),
    fee: String(row['fee']),
    priceImpactBps: Number(row['price_impact_bps']),
    partial: Number(row['partial']) === 1,
    latencyMs: Number(row['latency_ms']),
    engineVersion: Number(row['engine_version']),
    leafHash: String(row['leaf_hash']),
    createdAt: Number(row['created_at']),
  };
}

/**
 * Every trade an account has made, oldest first.
 *
 * Separate from `tradeHistory`, which pages backwards for a UI. Analytics has
 * to replay from the beginning — starting halfway through a log means starting
 * mid-position, and every statistic after that is drawn from a position whose
 * cost basis was never established.
 */
export async function allTrades(db: Client, accountId: number): Promise<TradeRow[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM trades WHERE account_id = ? ORDER BY sequence ASC, id ASC',
    args: [accountId],
  });
  return result.rows.map((row) => toTradeRow(row as unknown as Record<string, unknown>));
}
