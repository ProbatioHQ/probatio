import type { Client } from '@libsql/client';

/**
 * Fills pushed into a chat as they land.
 *
 * The cursor is the whole design. Deliveries are driven by the trade id, which
 * is an autoincrementing integer on an append-only table, so what a chat has
 * already been told is a single number and what is new is a range. There are no
 * timestamps and no windows, so two passes that overlap cannot deliver the same
 * fill twice and a pass that is skipped cannot lose one.
 *
 * The cursor advances only after a message is accepted by Telegram, which makes
 * delivery at least once rather than at most once. That is the right way round:
 * a duplicate is an annoyance and a missed fill is a broken promise. In practice
 * a duplicate needs the process to die between the send and the update, and it
 * is bounded to one batch.
 */

export interface WatchRow {
  readonly id: number;
  readonly chatId: number;
  readonly telegramUserId: number;
  readonly trader: string;
  readonly lastTradeId: number;
  readonly createdAt: number;
}

/**
 * How many traders one chat may follow.
 *
 * A ceiling rather than a policy. Without it, one member of a group can
 * subscribe the room to every wallet on the platform, and the room's only
 * recourse is removing the bot.
 */
export const MAX_WATCHES_PER_CHAT = 10;

export type WatchResult = 'added' | 'already' | 'too_many';

/**
 * Start delivering a trader's fills to a chat.
 *
 * The cursor starts at their newest fill, not at zero. Subscribing to somebody
 * with two thousand fills should not replay two thousand fills into the room.
 */
export async function watchTrader(
  db: Client,
  watch: { chatId: number; telegramUserId: number; trader: string; now: number },
): Promise<WatchResult> {
  const existing = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM telegram_watch WHERE chat_id = ?',
    args: [watch.chatId],
  });
  const count = Number(existing.rows[0]?.['n'] ?? 0);

  const already = await db.execute({
    sql: 'SELECT id FROM telegram_watch WHERE chat_id = ? AND trader = ?',
    args: [watch.chatId, watch.trader],
  });
  if (already.rows.length > 0) return 'already';

  if (count >= MAX_WATCHES_PER_CHAT) return 'too_many';

  const newest = await db.execute({
    sql: 'SELECT COALESCE(MAX(id), 0) AS latest FROM trades WHERE user_pubkey = ?',
    args: [watch.trader],
  });

  await db.execute({
    sql: `INSERT INTO telegram_watch (chat_id, telegram_user_id, trader, last_trade_id, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [
      watch.chatId,
      watch.telegramUserId,
      watch.trader,
      Number(newest.rows[0]?.['latest'] ?? 0),
      watch.now,
    ],
  });
  return 'added';
}

export async function unwatchTrader(db: Client, chatId: number, trader: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'DELETE FROM telegram_watch WHERE chat_id = ? AND trader = ?',
    args: [chatId, trader],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function watchesFor(db: Client, chatId: number): Promise<WatchRow[]> {
  const result = await db.execute({
    sql: `SELECT id, chat_id, telegram_user_id, trader, last_trade_id, created_at
          FROM telegram_watch WHERE chat_id = ? ORDER BY created_at`,
    args: [chatId],
  });
  return result.rows.map(toWatch);
}

function toWatch(row: Record<string, unknown>): WatchRow {
  return {
    id: Number(row['id']),
    chatId: Number(row['chat_id']),
    telegramUserId: Number(row['telegram_user_id']),
    trader: String(row['trader']),
    lastTradeId: Number(row['last_trade_id']),
    createdAt: Number(row['created_at']),
  };
}

export interface WatchedFill {
  readonly watchId: number;
  readonly chatId: number;
  readonly trader: string;
  readonly tradeId: number;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly createdAt: number;
}

/**
 * Everything owed to every chat, oldest first.
 *
 * One query rather than one per watch, because a pass that costs a round trip
 * per subscriber gets slower exactly as the bot gets more popular.
 *
 * The limit is a ceiling on a pass, not on a chat. Whatever does not fit is
 * still owed, its cursor has not moved, and the next pass twenty seconds later
 * picks it up.
 */
export async function pendingFills(db: Client, limit = 200): Promise<WatchedFill[]> {
  const result = await db.execute({
    sql: `SELECT w.id AS watch_id, w.chat_id, w.trader,
                 t.id AS trade_id, t.mint, t.side, t.sol_amount, t.token_amount,
                 t.price_impact_bps, t.partial, t.created_at
          FROM telegram_watch w
          JOIN trades t ON t.user_pubkey = w.trader AND t.id > w.last_trade_id
          ORDER BY t.id
          LIMIT ?`,
    args: [limit],
  });

  return result.rows.map((row) => ({
    watchId: Number(row['watch_id']),
    chatId: Number(row['chat_id']),
    trader: String(row['trader']),
    tradeId: Number(row['trade_id']),
    mint: String(row['mint']),
    side: String(row['side']) === 'sell' ? 'sell' : 'buy',
    solAmount: String(row['sol_amount']),
    tokenAmount: String(row['token_amount']),
    priceImpactBps: Number(row['price_impact_bps']),
    partial: Number(row['partial']) === 1,
    createdAt: Number(row['created_at']),
  }));
}

/**
 * Mark a batch delivered.
 *
 * Guarded on the cursor only moving forward. Two passes overlapping — a slow
 * one and the next one starting — would otherwise let the older pass rewind the
 * cursor and replay everything the newer one had already sent.
 */
export async function advanceWatch(db: Client, watchId: number, tradeId: number): Promise<void> {
  await db.execute({
    sql: 'UPDATE telegram_watch SET last_trade_id = ? WHERE id = ? AND last_trade_id < ?',
    args: [tradeId, watchId, tradeId],
  });
}

/**
 * Drop a chat's watches.
 *
 * Telegram tells us when the bot is blocked or thrown out of a group, and a
 * watch delivering into a chat that will never accept another message is a
 * failing send every twenty seconds, for ever.
 */
export async function dropChat(db: Client, chatId: number): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM telegram_watch WHERE chat_id = ?',
    args: [chatId],
  });
  return Number(result.rowsAffected ?? 0);
}
