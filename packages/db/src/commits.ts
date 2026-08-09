import type { Client } from '@libsql/client';

/**
 * Commit bookkeeping.
 *
 * Every function here exists to keep two systems that cannot be written
 * atomically — a Solana transaction and this database — from drifting apart in
 * a way that cannot be repaired.
 */

export interface PendingTrade {
  readonly id: number;
  readonly seasonId: number;
  readonly userPubkey: string;
  readonly engineVersion: number;
}

/**
 * Trades that have not been folded into any commit yet.
 *
 * A trade is uncommitted when its id falls outside every committed range for
 * its trader. Ranges rather than a flag on the trade, because trades are
 * append-only and cannot carry one.
 */
export async function uncommittedTrades(
  db: Client,
  limit = 5_000,
): Promise<PendingTrade[]> {
  const result = await db.execute({
    sql: `SELECT t.id, t.season_id, t.user_pubkey, t.engine_version
          FROM trades t
          WHERE NOT EXISTS (
            SELECT 1 FROM commits c
            WHERE c.season_id = t.season_id
              AND c.user_pubkey = t.user_pubkey
              AND t.id BETWEEN c.from_trade_id AND c.to_trade_id
          )
          ORDER BY t.season_id, t.user_pubkey, t.id
          LIMIT ?`,
    args: [limit],
  });

  return result.rows.map((row) => {
    const record = row as unknown as Record<string, unknown>;
    return {
      id: Number(record['id']),
      seasonId: Number(record['season_id']),
      userPubkey: String(record['user_pubkey']),
      engineVersion: Number(record['engine_version']),
    };
  });
}

export interface CommitIntent {
  readonly seasonId: number;
  readonly userPubkey: string;
  readonly merkleRoot: string;
  readonly leafCount: number;
  readonly fromTradeId: number;
  readonly toTradeId: number;
  readonly engineVersion: number;
  readonly previousAccumulator: string;
  readonly predictedAccumulator: string;
}

export interface StoredCommit extends CommitIntent {
  readonly id: number;
  readonly txSignature: string | null;
  readonly slot: number | null;
  readonly createdAt: number;
  readonly confirmedAt: number | null;
  readonly attempts: number;
  readonly failedReason: string | null;
}

function toStored(row: Record<string, unknown>): StoredCommit {
  const text = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);

  return {
    id: Number(row['id']),
    seasonId: Number(row['season_id']),
    userPubkey: String(row['user_pubkey']),
    merkleRoot: String(row['merkle_root']),
    leafCount: Number(row['leaf_count']),
    fromTradeId: Number(row['from_trade_id']),
    toTradeId: Number(row['to_trade_id']),
    engineVersion: Number(row['engine_version']),
    previousAccumulator: String(row['previous_accumulator'] ?? ''),
    predictedAccumulator: String(row['predicted_accumulator'] ?? ''),
    txSignature: text('tx_signature'),
    slot: row['slot'] === null || row['slot'] === undefined ? null : Number(row['slot']),
    createdAt: Number(row['created_at']),
    confirmedAt:
      row['confirmed_at'] === null || row['confirmed_at'] === undefined
        ? null
        : Number(row['confirmed_at']),
    attempts: Number(row['attempts'] ?? 0),
    failedReason: text('failed_reason'),
  };
}

/**
 * Record what is about to be sent, before sending it.
 *
 * This row is the only thing that makes a crash recoverable.
 */
export async function recordIntent(
  db: Client,
  intent: CommitIntent,
  now: number,
): Promise<number> {
  const result = await db.execute({
    sql: `INSERT INTO commits
            (season_id, user_pubkey, merkle_root, leaf_count, from_trade_id, to_trade_id,
             engine_version, previous_accumulator, predicted_accumulator, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [
      intent.seasonId,
      intent.userPubkey,
      intent.merkleRoot,
      intent.leafCount,
      intent.fromTradeId,
      intent.toTradeId,
      intent.engineVersion,
      intent.previousAccumulator,
      intent.predictedAccumulator,
      now,
    ],
  });
  return Number(result.rows[0]!['id']);
}

export async function markAttempted(db: Client, id: number): Promise<void> {
  await db.execute({
    sql: 'UPDATE commits SET attempts = attempts + 1 WHERE id = ?',
    args: [id],
  });
}

export async function markConfirmed(
  db: Client,
  id: number,
  txSignature: string,
  slot: number,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE commits SET tx_signature = ?, slot = ?, confirmed_at = ?, failed_reason = NULL
          WHERE id = ?`,
    args: [txSignature, slot, now, id],
  });
}

export async function markFailed(db: Client, id: number, reason: string): Promise<void> {
  await db.execute({
    sql: 'UPDATE commits SET failed_reason = ? WHERE id = ?',
    args: [reason.slice(0, 500), id],
  });
}

/**
 * Discard an intent that provably never reached the chain.
 *
 * Only safe once the on-chain accumulator has been read and found to still
 * hold the previous value. Deleting on any weaker evidence would let the same
 * trades be committed twice.
 */
export async function discardIntent(db: Client, id: number): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM commits WHERE id = ? AND confirmed_at IS NULL',
    args: [id],
  });
}

/** Unconfirmed intents, oldest first. What a restarting keeper reconciles. */
export async function pendingCommits(db: Client): Promise<StoredCommit[]> {
  const result = await db.execute(
    'SELECT * FROM commits WHERE confirmed_at IS NULL ORDER BY id',
  );
  return result.rows.map((row) => toStored(row as unknown as Record<string, unknown>));
}

/** The last confirmed commit for a trader, which carries the current accumulator. */
export async function lastConfirmedCommit(
  db: Client,
  seasonId: number,
  userPubkey: string,
): Promise<StoredCommit | null> {
  const result = await db.execute({
    sql: `SELECT * FROM commits
          WHERE season_id = ? AND user_pubkey = ? AND confirmed_at IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
    args: [seasonId, userPubkey],
  });
  const row = result.rows[0];
  return row ? toStored(row as unknown as Record<string, unknown>) : null;
}

/** Every confirmed commit for a trader, oldest first. What a verifier replays. */
export async function commitHistory(
  db: Client,
  seasonId: number,
  userPubkey: string,
): Promise<StoredCommit[]> {
  const result = await db.execute({
    sql: `SELECT * FROM commits
          WHERE season_id = ? AND user_pubkey = ? AND confirmed_at IS NOT NULL
          ORDER BY id`,
    args: [seasonId, userPubkey],
  });
  return result.rows.map((row) => toStored(row as unknown as Record<string, unknown>));
}
