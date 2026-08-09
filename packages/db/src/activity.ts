import type { Client } from '@libsql/client';

/**
 * Recording that a wallet was here today.
 *
 * Written on the way through requests that already identify a wallet, so it
 * costs one upsert per wallet per day rather than one per request. Nothing is
 * recorded for a visitor who has not signed in: there is no cookie to follow
 * them with and none is being added.
 */

export interface ActivityRow {
  readonly userPubkey: string;
  readonly day: number;
  readonly traded: boolean;
}

/**
 * Note a wallet as active.
 *
 * `traded` only ever goes from false to true. A trader who trades in the
 * morning and browses in the afternoon traded that day, and a later visit must
 * not erase it.
 */
export async function recordActivity(
  db: Client,
  userPubkey: string,
  day: number,
  traded: boolean,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO activity (user_pubkey, day, traded)
          VALUES (?, ?, ?)
          ON CONFLICT (user_pubkey, day) DO UPDATE SET
            traded = CASE WHEN excluded.traded = 1 THEN 1 ELSE activity.traded END`,
    args: [userPubkey, day, traded ? 1 : 0],
  });
}

/** Every recorded day, for computing cohorts. */
export async function allActivity(db: Client, sinceDay?: number): Promise<ActivityRow[]> {
  const result =
    sinceDay === undefined
      ? await db.execute('SELECT * FROM activity ORDER BY day')
      : await db.execute({
          sql: 'SELECT * FROM activity WHERE day >= ? ORDER BY day',
          args: [sinceDay],
        });

  return result.rows.map((row) => ({
    userPubkey: String(row['user_pubkey']),
    day: Number(row['day']),
    traded: Number(row['traded']) === 1,
  }));
}

export async function activeOn(db: Client, day: number): Promise<number> {
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM activity WHERE day = ?',
    args: [day],
  });
  return Number(result.rows[0]?.['n'] ?? 0);
}
