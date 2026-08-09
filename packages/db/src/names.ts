import type { Client } from '@libsql/client';

/**
 * Display names, and taking them away.
 *
 * A name is a claim on a scarce string, not a property of a trader. It can be
 * refused, given up or removed, and none of that touches a single result — the
 * chain commits to public keys, and a cleared name leaves every proof standing.
 */

export interface DisplayName {
  readonly id: number;
  readonly userPubkey: string;
  readonly name: string;
  readonly nameKey: string;
  readonly claimedAt: number;
  readonly clearedAt: number | null;
  readonly clearedNote: string | null;
}

function toName(row: Record<string, unknown>): DisplayName {
  return {
    id: Number(row['id']),
    userPubkey: String(row['user_pubkey']),
    name: String(row['name']),
    nameKey: String(row['name_key']),
    claimedAt: Number(row['claimed_at']),
    clearedAt: row['cleared_at'] === null ? null : Number(row['cleared_at']),
    clearedNote: row['cleared_note'] === null ? null : String(row['cleared_note']),
  };
}

/** The name to show for a trader, or null if they have none or lost it. */
export async function activeName(db: Client, userPubkey: string): Promise<string | null> {
  const result = await db.execute({
    sql: 'SELECT name FROM display_names WHERE user_pubkey = ? AND cleared_at IS NULL',
    args: [userPubkey],
  });
  return result.rows[0] ? String(result.rows[0]['name']) : null;
}

/** Names for a batch of traders. One query, for a leaderboard. */
export async function namesFor(
  db: Client,
  pubkeys: readonly string[],
): Promise<Map<string, string>> {
  if (pubkeys.length === 0) return new Map();

  const placeholders = pubkeys.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT user_pubkey, name FROM display_names
          WHERE cleared_at IS NULL AND user_pubkey IN (${placeholders})`,
    args: [...pubkeys],
  });

  return new Map(result.rows.map((row) => [String(row['user_pubkey']), String(row['name'])]));
}

export type ClaimOutcome = 'claimed' | 'taken' | 'already_yours';

/**
 * Claim a name.
 *
 * The unique index on the folded key is what enforces this, not the check
 * above it. Two people claiming the same name in the same instant both pass a
 * check-then-write, and only one can pass a constraint.
 *
 * A key belonging to a cleared row stays taken. Releasing a moderated name back
 * into the pool hands it to whoever was waiting for exactly that.
 */
export async function claimName(
  db: Client,
  userPubkey: string,
  name: string,
  nameKey: string,
  now: number,
): Promise<ClaimOutcome> {
  const existing = await db.execute({
    sql: 'SELECT user_pubkey, cleared_at FROM display_names WHERE name_key = ?',
    args: [nameKey],
  });

  const holder = existing.rows[0];
  if (holder) {
    if (String(holder['user_pubkey']) !== userPubkey) return 'taken';
    if (holder['cleared_at'] !== null) return 'taken';
    // Re-claiming the same key with different capitalisation is a rename.
    await db.execute({
      sql: 'UPDATE display_names SET name = ? WHERE user_pubkey = ?',
      args: [name, userPubkey],
    });
    return 'already_yours';
  }

  const tx = await db.transaction('write');
  try {
    // Retire the live name first. Kept rather than deleted, so a name given up
    // voluntarily also stays reserved — otherwise renaming is a way to park a
    // name for somebody else to take a second later.
    await tx.execute({
      sql: `UPDATE display_names SET cleared_at = ?, cleared_note = 'renamed'
            WHERE user_pubkey = ? AND cleared_at IS NULL`,
      args: [now, userPubkey],
    });
    await tx.execute({
      sql: `INSERT INTO display_names (user_pubkey, name, name_key, claimed_at)
            VALUES (?, ?, ?, ?)`,
      args: [userPubkey, name, nameKey, now],
    });
    await tx.commit();
    return 'claimed';
  } catch (error) {
    await tx.rollback();
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      return 'taken';
    }
    throw error;
  }
}

/**
 * Take a name away.
 *
 * Records why. A moderation action with no reason attached is indistinguishable
 * from a mistake later, including to whoever has to defend it.
 */
export async function clearName(
  db: Client,
  userPubkey: string,
  note: string,
  now: number,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE display_names SET cleared_at = ?, cleared_note = ?
          WHERE user_pubkey = ? AND cleared_at IS NULL`,
    args: [now, note, userPubkey],
  });
  return result.rowsAffected > 0;
}

/** The wallet's live name row, or the most recent one if it was cleared. */
export async function nameRecord(db: Client, userPubkey: string): Promise<DisplayName | null> {
  const result = await db.execute({
    sql: `SELECT * FROM display_names WHERE user_pubkey = ?
          ORDER BY (cleared_at IS NULL) DESC, claimed_at DESC LIMIT 1`,
    args: [userPubkey],
  });
  return result.rows[0] ? toName(result.rows[0] as unknown as Record<string, unknown>) : null;
}

/** Every name a wallet has held, newest first. */
export async function nameHistory(db: Client, userPubkey: string): Promise<DisplayName[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM display_names WHERE user_pubkey = ? ORDER BY claimed_at DESC, id DESC',
    args: [userPubkey],
  });
  return result.rows.map((row) => toName(row as unknown as Record<string, unknown>));
}
