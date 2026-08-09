import type { Client } from '@libsql/client';

/**
 * Payments, and the intents that precede them.
 *
 * The distinction is the whole design. An intent is something the server asked
 * for; a payment is a transaction that exists on chain. Only the second one may
 * credit anybody, and the two are separate tables so that nothing can confuse
 * having asked with having been paid.
 */

export type PaymentPurpose = 'season_entry' | 'coach_upgrade';
export type PaymentStatus = 'pending' | 'verified' | 'failed';

export interface PaymentIntentRow {
  readonly id: number;
  readonly reference: string;
  readonly userPubkey: string;
  readonly seasonId: number | null;
  readonly purpose: PaymentPurpose;
  readonly recipient: string;
  readonly amount: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly paymentId: number | null;
}

export interface PaymentRow {
  readonly id: number;
  readonly userPubkey: string;
  readonly seasonId: number | null;
  readonly purpose: PaymentPurpose;
  readonly amount: string;
  readonly txSignature: string;
  readonly status: PaymentStatus;
  readonly createdAt: number;
  readonly verifiedAt: number | null;
}

function toIntent(row: Record<string, unknown>): PaymentIntentRow {
  return {
    id: Number(row['id']),
    reference: String(row['reference']),
    userPubkey: String(row['user_pubkey']),
    seasonId: row['season_id'] === null ? null : Number(row['season_id']),
    purpose: String(row['purpose']) as PaymentPurpose,
    recipient: String(row['recipient']),
    amount: String(row['amount']),
    createdAt: Number(row['created_at']),
    expiresAt: Number(row['expires_at']),
    paymentId: row['payment_id'] === null ? null : Number(row['payment_id']),
  };
}

function toPayment(row: Record<string, unknown>): PaymentRow {
  return {
    id: Number(row['id']),
    userPubkey: String(row['user_pubkey']),
    seasonId: row['season_id'] === null ? null : Number(row['season_id']),
    purpose: String(row['purpose']) as PaymentPurpose,
    amount: String(row['amount']),
    txSignature: String(row['tx_signature']),
    status: String(row['status']) as PaymentStatus,
    createdAt: Number(row['created_at']),
    verifiedAt: row['verified_at'] === null ? null : Number(row['verified_at']),
  };
}

export interface PaymentIntentWrite {
  readonly reference: string;
  readonly userPubkey: string;
  readonly seasonId: number | null;
  readonly purpose: PaymentPurpose;
  readonly recipient: string;
  readonly amount: string;
  readonly expiresAt: number;
}

export async function createPaymentIntent(
  db: Client,
  write: PaymentIntentWrite,
  now: number,
): Promise<PaymentIntentRow> {
  const result = await db.execute({
    sql: `INSERT INTO payment_intents
            (reference, user_pubkey, season_id, purpose, recipient, amount, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING *`,
    args: [
      write.reference,
      write.userPubkey,
      write.seasonId,
      write.purpose,
      write.recipient,
      write.amount,
      now,
      write.expiresAt,
    ],
  });
  return toIntent(result.rows[0] as unknown as Record<string, unknown>);
}

export async function getPaymentIntent(
  db: Client,
  reference: string,
): Promise<PaymentIntentRow | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM payment_intents WHERE reference = ?',
    args: [reference],
  });
  const row = result.rows[0];
  return row ? toIntent(row as unknown as Record<string, unknown>) : null;
}

/** Intents that were never paid and have not expired, oldest first. */
export async function openPaymentIntents(
  db: Client,
  now: number,
  limit = 100,
): Promise<PaymentIntentRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM payment_intents
          WHERE payment_id IS NULL AND expires_at > ?
          ORDER BY created_at ASC LIMIT ?`,
    args: [now, limit],
  });
  return result.rows.map((row) => toIntent(row as unknown as Record<string, unknown>));
}

export interface Settlement {
  readonly payment: PaymentRow;
  /** True when this call is what credited it, false when it already was. */
  readonly fresh: boolean;
  /** The season entry, when the payment bought one. */
  readonly entryId: number | null;
}

/**
 * Credit a verified payment.
 *
 * Everything happens in one transaction: the payment row, the link back to its
 * intent, and the season entry it bought. A payment recorded without its entry
 * is a user who paid and did not get in, which is the worst outcome available
 * here.
 *
 * Idempotent by way of the unique index on the signature. Calling twice with
 * the same transaction returns the first result rather than crediting twice,
 * because a user who retries a confirmation is not paying again — and the
 * confirmation endpoint is exactly the sort of thing a nervous user clicks
 * more than once.
 */
export async function settlePayment(
  db: Client,
  input: {
    readonly reference: string;
    readonly txSignature: string;
    readonly userPubkey: string;
    readonly seasonId: number | null;
    readonly purpose: PaymentPurpose;
    readonly amount: string;
    readonly now: number;
  },
): Promise<Settlement> {
  const existing = await db.execute({
    sql: 'SELECT * FROM payments WHERE tx_signature = ?',
    args: [input.txSignature],
  });
  if (existing.rows[0]) {
    const payment = toPayment(existing.rows[0] as unknown as Record<string, unknown>);
    return { payment, fresh: false, entryId: await findEntry(db, payment) };
  }

  const tx = await db.transaction('write');
  try {
    const inserted = await tx.execute({
      sql: `INSERT INTO payments
              (user_pubkey, season_id, purpose, amount, tx_signature, status, created_at, verified_at)
            VALUES (?, ?, ?, ?, ?, 'verified', ?, ?)
            RETURNING *`,
      args: [
        input.userPubkey,
        input.seasonId,
        input.purpose,
        input.amount,
        input.txSignature,
        input.now,
        input.now,
      ],
    });
    const payment = toPayment(inserted.rows[0] as unknown as Record<string, unknown>);

    await tx.execute({
      sql: 'UPDATE payment_intents SET payment_id = ? WHERE reference = ? AND payment_id IS NULL',
      args: [payment.id, input.reference],
    });

    let entryId: number | null = null;
    if (input.purpose === 'season_entry' && input.seasonId !== null) {
      // ON CONFLICT DO NOTHING rather than an error: a user already entered is
      // a user already entered, and their payment still needs recording.
      // The evidence follows the intent onto the entry. Re-gathering it here
      // would read a wallet that has had time to change since it was checked.
      const entry = await tx.execute({
        sql: `INSERT INTO entries
                (season_id, user_pubkey, payment_id, entered_at,
                 funder, wallet_first_seen_at, wallet_signature_count, evidence_flags)
              SELECT ?, ?, ?, ?, funder, wallet_first_seen_at, wallet_signature_count,
                     COALESCE(evidence_flags, '[]')
              FROM payment_intents WHERE reference = ?
              ON CONFLICT (season_id, user_pubkey) DO NOTHING
              RETURNING id`,
        args: [input.seasonId, input.userPubkey, payment.id, input.now, input.reference],
      });
      entryId = entry.rows[0] ? Number(entry.rows[0]['id']) : null;
    }

    await tx.commit();
    return { payment, fresh: true, entryId };
  } catch (error) {
    await tx.rollback();

    // Another request settled the same signature between the check above and
    // the insert. Theirs is the same payment, so read it back rather than
    // reporting a failure for something that succeeded.
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      const raced = await db.execute({
        sql: 'SELECT * FROM payments WHERE tx_signature = ?',
        args: [input.txSignature],
      });
      if (raced.rows[0]) {
        const payment = toPayment(raced.rows[0] as unknown as Record<string, unknown>);
        return { payment, fresh: false, entryId: await findEntry(db, payment) };
      }
    }
    throw error;
  }
}

async function findEntry(db: Client, payment: PaymentRow): Promise<number | null> {
  if (payment.seasonId === null) return null;
  const result = await db.execute({
    sql: 'SELECT id FROM entries WHERE season_id = ? AND user_pubkey = ?',
    args: [payment.seasonId, payment.userPubkey],
  });
  return result.rows[0] ? Number(result.rows[0]['id']) : null;
}

export async function paymentsFor(db: Client, userPubkey: string): Promise<PaymentRow[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM payments WHERE user_pubkey = ? ORDER BY created_at DESC',
    args: [userPubkey],
  });
  return result.rows.map((row) => toPayment(row as unknown as Record<string, unknown>));
}

export async function hasEntered(
  db: Client,
  seasonId: number,
  userPubkey: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT 1 FROM entries WHERE season_id = ? AND user_pubkey = ?',
    args: [seasonId, userPubkey],
  });
  return result.rows.length > 0;
}

export interface EvidenceWrite {
  readonly funder: string | null;
  readonly walletFirstSeenAt: number | null;
  readonly walletSignatureCount: number;
  readonly flags: readonly string[];
}

/**
 * How many entries in this season trace back to one funding source.
 *
 * Counts settled entries and outstanding intents together. Counting only
 * entries would let somebody open fifty intents in the same second, each seeing
 * no siblings, and pay them all — the limit would be enforced against nobody.
 *
 * Expired intents are excluded: an abandoned request should not hold a slot
 * against a source forever.
 */
export async function entriesFromFunder(
  db: Client,
  seasonId: number,
  funder: string,
  now: number,
): Promise<number> {
  const settled = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM entries WHERE season_id = ? AND funder = ?',
    args: [seasonId, funder],
  });

  const pending = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM payment_intents
          WHERE season_id = ? AND funder = ? AND payment_id IS NULL AND expires_at > ?`,
    args: [seasonId, funder, now],
  });

  return Number(settled.rows[0]?.['n'] ?? 0) + Number(pending.rows[0]?.['n'] ?? 0);
}

/** Attach the evidence gathered when this intent was created. */
export async function recordIntentEvidence(
  db: Client,
  reference: string,
  evidence: EvidenceWrite,
): Promise<void> {
  await db.execute({
    sql: `UPDATE payment_intents
          SET funder = ?, wallet_first_seen_at = ?, wallet_signature_count = ?, evidence_flags = ?
          WHERE reference = ?`,
    args: [
      evidence.funder,
      evidence.walletFirstSeenAt,
      evidence.walletSignatureCount,
      JSON.stringify(evidence.flags),
      reference,
    ],
  });
}

export interface EntryEvidence {
  readonly userPubkey: string;
  readonly funder: string | null;
  readonly walletFirstSeenAt: number | null;
  readonly walletSignatureCount: number | null;
  readonly flags: readonly string[];
  readonly enteredAt: number;
}

/**
 * The evidence recorded against every entry in a season.
 *
 * Read when somebody asks whether a record is worth backing. It is the only
 * place the nineteen discarded wallets are still visible.
 */
export async function seasonEvidence(db: Client, seasonId: number): Promise<EntryEvidence[]> {
  const result = await db.execute({
    sql: `SELECT user_pubkey, funder, wallet_first_seen_at, wallet_signature_count,
                 evidence_flags, entered_at
          FROM entries WHERE season_id = ?`,
    args: [seasonId],
  });

  return result.rows.map((row) => {
    let flags: string[] = [];
    try {
      const parsed: unknown = JSON.parse(String(row['evidence_flags'] ?? '[]'));
      if (Array.isArray(parsed)) flags = parsed as string[];
    } catch {
      // Unreadable flags are no flags. The entry still happened.
    }
    return {
      userPubkey: String(row['user_pubkey']),
      funder: row['funder'] === null ? null : String(row['funder']),
      walletFirstSeenAt:
        row['wallet_first_seen_at'] === null ? null : Number(row['wallet_first_seen_at']),
      walletSignatureCount:
        row['wallet_signature_count'] === null ? null : Number(row['wallet_signature_count']),
      flags,
      enteredAt: Number(row['entered_at']),
    };
  });
}
