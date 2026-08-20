import type { Client } from '@libsql/client';

/**
 * Connecting a Telegram account to a wallet.
 *
 * The link cannot be made from Telegram alone. Telegram knows who is typing and
 * has no idea which wallet they own, so a bot that accepted a pasted address
 * would let anybody claim anybody's record, which on a site whose whole product
 * is verifiable records is the worst possible thing to get wrong.
 *
 * So it goes the other way round. The bot issues a code, the site asks for a
 * signature, and the signature is what proves the wallet. The code only has to
 * survive the walk from one to the other.
 */

/** Long enough that guessing is pointless, short enough to read aloud. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** How long a code is worth anything. */
export const CODE_TTL_MS = 10 * 60 * 1_000;

export interface LinkCode {
  readonly code: string;
  readonly expiresAt: number;
}

function makeCode(random: () => number): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return code;
}

/**
 * Issue a code for a Telegram account.
 *
 * Any code that account already has is dropped first. Somebody who types /link
 * twice because the first message scrolled away should not leave a live code
 * behind them, and the newest one is the only one they can see.
 */
export async function issueLinkCode(
  db: Client,
  telegramUserId: number,
  chatId: number,
  now: number,
  random: () => number = Math.random,
): Promise<LinkCode> {
  await db.execute({
    sql: 'DELETE FROM telegram_link_codes WHERE telegram_user_id = ? AND claimed_at IS NULL',
    args: [telegramUserId],
  });

  const code = makeCode(random);
  await db.execute({
    sql: `INSERT INTO telegram_link_codes (code, telegram_user_id, chat_id, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [code, telegramUserId, chatId, now],
  });
  return { code, expiresAt: now + CODE_TTL_MS };
}

export type ClaimOutcome =
  | { readonly status: 'linked'; readonly telegramUserId: number; readonly chatId: number }
  | { readonly status: 'unknown' }
  | { readonly status: 'expired' }
  | { readonly status: 'used' }
  | { readonly status: 'wallet_taken' }
  | { readonly status: 'telegram_taken' };

/**
 * Redeem a code against a signed-in wallet.
 *
 * Every refusal is named rather than collapsed into one. "That code does not
 * exist" and "that code has expired" send somebody to different places, and a
 * link flow that says only "failed" is a link flow people give up on.
 *
 * Claimed before the link is written, so a code that races itself is spent
 * once. Both writes are in one transaction because a spent code with no link
 * behind it strands somebody with nothing to retry.
 */
export async function claimLinkCode(
  db: Client,
  code: string,
  userPubkey: string,
  now: number,
): Promise<ClaimOutcome> {
  const found = await db.execute({
    sql: `SELECT telegram_user_id, chat_id, created_at, claimed_at
          FROM telegram_link_codes WHERE code = ?`,
    args: [code.trim().toUpperCase()],
  });
  const row = found.rows[0];
  if (!row) return { status: 'unknown' };
  if (row['claimed_at'] !== null) return { status: 'used' };
  if (now - Number(row['created_at']) > CODE_TTL_MS) return { status: 'expired' };

  const telegramUserId = Number(row['telegram_user_id']);
  const chatId = Number(row['chat_id']);

  // Named separately because they are different problems with different
  // answers: one wallet is already somebody's Telegram, the other is this
  // Telegram already having a wallet.
  const wallet = await db.execute({
    sql: 'SELECT telegram_user_id FROM telegram_links WHERE user_pubkey = ?',
    args: [userPubkey],
  });
  const existing = wallet.rows[0];
  if (existing && Number(existing['telegram_user_id']) !== telegramUserId) {
    return { status: 'wallet_taken' };
  }

  const chat = await db.execute({
    sql: 'SELECT user_pubkey FROM telegram_links WHERE telegram_user_id = ?',
    args: [telegramUserId],
  });
  const held = chat.rows[0];
  if (held && String(held['user_pubkey']) !== userPubkey) return { status: 'telegram_taken' };

  const transaction = await db.transaction('write');
  try {
    const spent = await transaction.execute({
      sql: 'UPDATE telegram_link_codes SET claimed_at = ? WHERE code = ? AND claimed_at IS NULL',
      args: [now, code.trim().toUpperCase()],
    });
    // Somebody else redeemed it between the read above and this write.
    if (Number(spent.rowsAffected ?? 0) === 0) {
      await transaction.rollback();
      return { status: 'used' };
    }

    await transaction.execute({
      sql: `INSERT INTO telegram_links (telegram_user_id, user_pubkey, linked_at)
            VALUES (?, ?, ?)
            ON CONFLICT (telegram_user_id) DO UPDATE SET
              user_pubkey = excluded.user_pubkey, linked_at = excluded.linked_at`,
      args: [telegramUserId, userPubkey, now],
    });
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return { status: 'linked', telegramUserId, chatId };
}

/** The wallet behind a Telegram account, or null if it has never been linked. */
export async function linkedWallet(db: Client, telegramUserId: number): Promise<string | null> {
  const result = await db.execute({
    sql: 'SELECT user_pubkey FROM telegram_links WHERE telegram_user_id = ?',
    args: [telegramUserId],
  });
  const row = result.rows[0];
  return row ? String(row['user_pubkey']) : null;
}

/** The Telegram account behind a wallet, for the site to show what is connected. */
export async function linkedTelegram(db: Client, userPubkey: string): Promise<number | null> {
  const result = await db.execute({
    sql: 'SELECT telegram_user_id FROM telegram_links WHERE user_pubkey = ?',
    args: [userPubkey],
  });
  const row = result.rows[0];
  return row ? Number(row['telegram_user_id']) : null;
}

/** Disconnect. Nothing about the record changes; only where orders may come from. */
export async function unlinkTelegram(db: Client, userPubkey: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'DELETE FROM telegram_links WHERE user_pubkey = ?',
    args: [userPubkey],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

/** Drop codes nobody redeemed. They are worthless once they have expired. */
export async function pruneLinkCodes(db: Client, now: number): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM telegram_link_codes WHERE created_at < ?',
    args: [now - 24 * 60 * 60 * 1_000],
  });
  return Number(result.rowsAffected ?? 0);
}
