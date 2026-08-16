import type { Client, InStatement } from '@libsql/client';
import { decodeAmount, encodeAmount } from './amount';

/**
 * The database side of the payout engine.
 *
 * These record what the chain did, they do not decide it. A season is finalized
 * on chain by `finalize_season` and only then written here; an entry is created
 * by `record_entry` and only then written here; a prize leaves by `claim_prize`
 * or `refund_entry` and this marks which, so it cannot leave twice. The money
 * itself never moves through this file — it moves through the program, and this
 * is the record of it that the site can read.
 */

/** A season's lifecycle status, mirroring the on-chain one. Voided is tracked separately. */
export type SeasonLifecycle = 'pending' | 'entry_open' | 'running' | 'closed' | 'finalized';

/** Store the on-chain address a season was created under. Written once. */
export async function setSeasonOnchain(
  db: Client,
  input: { readonly seasonId: number; readonly onchainPubkey: string },
): Promise<void> {
  await db.execute({
    sql: 'UPDATE seasons SET onchain_pubkey = ? WHERE id = ? AND onchain_pubkey IS NULL',
    args: [input.onchainPubkey, input.seasonId],
  });
}

/** The on-chain address a season was created under, or null if it is not on chain yet. */
export async function seasonOnchainPubkey(
  db: Client,
  seasonId: number,
): Promise<string | null> {
  const result = await db.execute({
    sql: 'SELECT onchain_pubkey FROM seasons WHERE id = ?',
    args: [seasonId],
  });
  const value = result.rows[0]?.['onchain_pubkey'];
  return value === null || value === undefined ? null : String(value);
}

/** Advance a season's status to mirror an on-chain transition (open, start, close). */
export async function setSeasonStatus(
  db: Client,
  input: { readonly seasonId: number; readonly status: SeasonLifecycle },
): Promise<void> {
  await db.execute({
    sql: 'UPDATE seasons SET status = ? WHERE id = ?',
    args: [input.status, input.seasonId],
  });
}

/** The payout transaction already sent to a trader, or null if they are unpaid. */
export async function entryPayoutSignature(
  db: Client,
  input: { readonly seasonId: number; readonly trader: string },
): Promise<string | null> {
  const result = await db.execute({
    sql: 'SELECT payout_tx_signature FROM entries WHERE season_id = ? AND user_pubkey = ?',
    args: [input.seasonId, input.trader],
  });
  const value = result.rows[0]?.['payout_tx_signature'];
  return value === null || value === undefined ? null : String(value);
}

/** Record that a winner was paid: the amount, the transaction, and when. */
export async function recordPayout(
  db: Client,
  input: {
    readonly seasonId: number;
    readonly trader: string;
    readonly payout: bigint;
    readonly txSignature: string;
    readonly now: number;
  },
): Promise<void> {
  await db.execute({
    sql: `UPDATE entries SET payout = ?, payout_tx_signature = ?, claimed_at = ?
            WHERE season_id = ? AND user_pubkey = ? AND payout_tx_signature IS NULL`,
    args: [encodeAmount(input.payout), input.txSignature, input.now, input.seasonId, input.trader],
  });
}

/** Mark a season finalized once its winners have been paid. */
export async function markSeasonFinalized(
  db: Client,
  input: { readonly seasonId: number; readonly now: number },
): Promise<void> {
  await db.execute({
    sql: `UPDATE seasons SET status = 'finalized', finalized_at = ? WHERE id = ?`,
    args: [input.now, input.seasonId],
  });
}

/** Mark a season voided so its entries can be refunded. */
export async function markSeasonVoided(
  db: Client,
  input: { readonly seasonId: number; readonly now: number },
): Promise<void> {
  await db.execute({
    sql: 'UPDATE seasons SET voided_at = ? WHERE id = ? AND voided_at IS NULL',
    args: [input.now, input.seasonId],
  });
}

/** One entrant's finalized result, as computed by `buildFinalization`. */
export interface FinalizedEntry {
  readonly trader: string;
  readonly rank: number;
  readonly startingBalance: bigint;
  readonly finalEquity: bigint;
  readonly returnBps: number;
  readonly tradeCount: number;
  readonly payoutLamports: bigint;
  /** The merkle proof of this entrant's leaf, siblings as 64-char hex. */
  readonly proof: readonly { readonly sibling: string; readonly siblingOnLeft: boolean }[];
}

/**
 * Freeze a finalized season and every entrant's result, in one transaction.
 *
 * Written only after `finalize_season` has recorded the same `resultsRoot` on
 * chain, so the site and the program cannot disagree about what a season paid.
 * Every entrant is stored, not just the paid places, so each carries the proof
 * that lets its trader claim — a zero payout simply cannot be claimed on chain.
 */
export async function recordFinalization(
  db: Client,
  input: {
    readonly seasonId: number;
    readonly resultsRoot: string;
    readonly rows: readonly FinalizedEntry[];
    readonly now: number;
  },
): Promise<void> {
  const statements: InStatement[] = [
    {
      sql: `UPDATE seasons SET status = 'finalized', finalized_at = ?, results_root = ?
              WHERE id = ?`,
      args: [input.now, input.resultsRoot, input.seasonId],
    },
    ...input.rows.map((row): InStatement => ({
      sql: `UPDATE entries
              SET rank = ?, starting_balance = ?, final_equity = ?, return_bps = ?,
                  trade_count = ?, payout = ?, proof = ?
              WHERE season_id = ? AND user_pubkey = ?`,
      args: [
        row.rank,
        encodeAmount(row.startingBalance),
        encodeAmount(row.finalEquity),
        row.returnBps,
        row.tradeCount,
        encodeAmount(row.payoutLamports),
        JSON.stringify(row.proof),
        input.seasonId,
        row.trader,
      ],
    })),
  ];
  await db.batch(statements, 'write');
}

/** Record the on-chain Entry a trader created by paying the fee into the vault. */
export async function recordOnChainEntry(
  db: Client,
  input: {
    readonly seasonId: number;
    readonly userPubkey: string;
    readonly onchainEntryPubkey: string;
    readonly entryTxSignature: string;
    readonly paid: bigint;
    readonly evidence: {
      readonly funder: string | null;
      readonly walletFirstSeenAt: number | null;
      readonly walletSignatureCount: number | null;
      readonly flags: readonly string[];
    };
    readonly now: number;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO entries
            (season_id, user_pubkey, payment_id, entered_at, paid,
             onchain_entry_pubkey, entry_tx_signature,
             funder, wallet_first_seen_at, wallet_signature_count, evidence_flags)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (season_id, user_pubkey) DO UPDATE SET
            paid = excluded.paid,
            onchain_entry_pubkey = excluded.onchain_entry_pubkey,
            entry_tx_signature = excluded.entry_tx_signature`,
    args: [
      input.seasonId,
      input.userPubkey,
      input.now,
      encodeAmount(input.paid),
      input.onchainEntryPubkey,
      input.entryTxSignature,
      input.evidence.funder,
      input.evidence.walletFirstSeenAt,
      input.evidence.walletSignatureCount,
      JSON.stringify(input.evidence.flags),
    ],
  });
}

/** What a trader needs to claim a prize: the frozen result, its proof, and the root. */
export interface ClaimData {
  readonly seasonOrdinal: number;
  readonly seasonOnchainPubkey: string | null;
  readonly resultsRoot: string | null;
  readonly voided: boolean;
  readonly claimedAt: number | null;
  readonly refundedAt: number | null;
  readonly rank: number | null;
  readonly startingBalance: bigint | null;
  readonly finalEquity: bigint | null;
  readonly returnBps: number | null;
  readonly tradeCount: number | null;
  readonly payoutLamports: bigint | null;
  readonly proof: readonly { readonly sibling: string; readonly siblingOnLeft: boolean }[] | null;
}

/** A trader's claim in a season, or null if they have no entry there. */
export async function claimData(
  db: Client,
  input: { readonly seasonId: number; readonly trader: string },
): Promise<ClaimData | null> {
  const result = await db.execute({
    sql: `SELECT s.ordinal AS ordinal, s.onchain_pubkey AS onchain, s.results_root AS root,
                 s.voided_at AS voided,
                 e.claimed_at AS claimed_at, e.refunded_at AS refunded_at,
                 e.rank AS rank, e.starting_balance AS starting_balance,
                 e.final_equity AS final_equity, e.return_bps AS return_bps,
                 e.trade_count AS trade_count, e.payout AS payout, e.proof AS proof
            FROM entries e JOIN seasons s ON s.id = e.season_id
           WHERE e.season_id = ? AND e.user_pubkey = ?`,
    args: [input.seasonId, input.trader],
  });
  const row = result.rows[0];
  if (!row) return null;

  const proofRaw = row['proof'];
  return {
    seasonOrdinal: Number(row['ordinal']),
    seasonOnchainPubkey: row['onchain'] === null ? null : String(row['onchain']),
    resultsRoot: row['root'] === null ? null : String(row['root']),
    voided: row['voided'] !== null,
    claimedAt: row['claimed_at'] === null ? null : Number(row['claimed_at']),
    refundedAt: row['refunded_at'] === null ? null : Number(row['refunded_at']),
    rank: row['rank'] === null ? null : Number(row['rank']),
    startingBalance: row['starting_balance'] === null ? null : decodeAmount(String(row['starting_balance'])),
    finalEquity: row['final_equity'] === null ? null : decodeAmount(String(row['final_equity'])),
    returnBps: row['return_bps'] === null ? null : Number(row['return_bps']),
    tradeCount: row['trade_count'] === null ? null : Number(row['trade_count']),
    payoutLamports: row['payout'] === null ? null : decodeAmount(String(row['payout'])),
    proof:
      typeof proofRaw === 'string'
        ? (JSON.parse(proofRaw) as { sibling: string; siblingOnLeft: boolean }[])
        : null,
  };
}

/** Mark a prize claimed. Guards against a second claim by requiring it unclaimed. */
export async function markEntryClaimed(
  db: Client,
  input: { readonly seasonId: number; readonly trader: string; readonly txSignature: string; readonly now: number },
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE entries SET claimed_at = ?, payout_tx_signature = ?
            WHERE season_id = ? AND user_pubkey = ? AND claimed_at IS NULL AND refunded_at IS NULL`,
    args: [input.now, input.txSignature, input.seasonId, input.trader],
  });
  return result.rowsAffected > 0;
}

/** Mark an entry refunded. Guards against a refund after a claim, or a second refund. */
export async function markEntryRefunded(
  db: Client,
  input: { readonly seasonId: number; readonly trader: string; readonly txSignature: string; readonly now: number },
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE entries SET refunded_at = ?, payout_tx_signature = ?
            WHERE season_id = ? AND user_pubkey = ? AND refunded_at IS NULL AND claimed_at IS NULL`,
    args: [input.now, input.txSignature, input.seasonId, input.trader],
  });
  return result.rowsAffected > 0;
}
