import type { Client } from '@libsql/client';

/**
 * Handling each Telegram update exactly once.
 *
 * Telegram redelivers an update until the webhook answers, and it will redeliver
 * one that was already handled if the answer was slow or went missing. That is
 * correct of them and dangerous here: a retried update is a second trade, the
 * same tap filled twice, on an account whose entire value is that its record is
 * exact.
 *
 * The claim is the insert. Two deliveries of the same update race the primary
 * key rather than a read, so only one of them can win however they interleave,
 * which a select-then-insert could not promise.
 */

/** True when this update has not been handled before, and is now claimed. */
export async function claimUpdate(db: Client, updateId: number, now: number): Promise<boolean> {
  const result = await db.execute({
    sql: 'INSERT INTO telegram_updates (update_id, seen_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
    args: [updateId, now],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

/**
 * Forget updates older than the window.
 *
 * Telegram gives up redelivering long before this, so anything older cannot be
 * retried and the row is only taking space. A day is generous.
 */
export async function pruneUpdates(db: Client, now: number): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM telegram_updates WHERE seen_at < ?',
    args: [now - 24 * 60 * 60 * 1_000],
  });
  return Number(result.rowsAffected ?? 0);
}
