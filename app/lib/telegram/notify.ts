import 'server-only';
import { advanceWatch, dropChat, pendingFills, type WatchedFill } from '@probatio/db';
import { db } from '../db';
import { resolveTokenName } from '../token-name';
import { telegram } from './transport';
import type { Telegram } from './transport';
import { formatSol } from './trade';
import { shortMint } from './trade-cards';
import { b, html, lines, rows } from './format';

/**
 * Pushing fills into a chat as they land.
 *
 * The interesting part is not the sending, it is that this cannot deliver the
 * same fill twice or skip one. Trade ids are an autoincrementing integer on an
 * append-only table, so what a chat has been told is a single number and what
 * is owed is a range. No timestamps, no windows, nothing that goes wrong when
 * two passes overlap or one is missed.
 *
 * The cursor advances only after Telegram accepts the message, which makes
 * delivery at least once rather than at most once. That is the right way round:
 * a duplicate is an annoyance, a missed fill is a broken promise. A duplicate
 * needs the process to die between the send and the update, and is bounded to
 * one batch.
 */

/**
 * How often the pass runs.
 *
 * Twenty seconds. A fill that arrives in a chat twenty seconds late is still a
 * live feed to a person reading it, and the alternative, a tighter loop, buys
 * nothing but queries against a database that is single writer.
 */
const CYCLE_MS = 20_000;

/**
 * How many fills one chat is told about in one message.
 *
 * Telegram will take twenty messages a minute to a group, and a trader on a
 * tear can produce more fills than that. So a pass sends one message per chat
 * however many fills it holds, and past this the message says how many more
 * there were rather than growing without limit.
 */
const MAX_LINES = 12;

/** A ceiling on a pass, not on a chat. Whatever does not fit is still owed. */
const PASS_LIMIT = 300;

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

async function line(fill: WatchedFill): Promise<string> {
  const named = await resolveTokenName(fill.mint);
  const token = named.known ? named.symbol ?? named.name : shortMint(fill.mint);
  const sol = formatSol(BigInt(fill.solAmount));
  return html`${fill.side === 'buy' ? 'bought' : 'sold'} ${token} for ${b(`${sol} SOL`)}${
    fill.partial ? ' (partial)' : ''
  }`;
}

const SITE = process.env['PROBATIO_SITE'] ?? 'https://probatiotrade.com';

/**
 * One pass.
 *
 * Grouped by chat rather than by watch, because a chat watching three traders
 * who all fill in the same twenty seconds should get one message, not three.
 * Exported so a test can run exactly one pass against a fake.
 */
export async function deliverWatches(post: Telegram, now = Date.now()): Promise<number> {
  const client = await db();
  const owed = await pendingFills(client, PASS_LIMIT);
  if (owed.length === 0) return 0;

  const byChat = new Map<number, WatchedFill[]>();
  for (const fill of owed) {
    const existing = byChat.get(fill.chatId);
    if (existing) existing.push(fill);
    else byChat.set(fill.chatId, [fill]);
  }

  let sent = 0;
  for (const [chatId, fills] of byChat) {
    const shown = fills.slice(0, MAX_LINES);
    const byTrader = new Map<string, string[]>();
    for (const fill of shown) {
      const lines = byTrader.get(fill.trader) ?? [];
      lines.push(await line(fill));
      byTrader.set(fill.trader, lines);
    }

    const body = [...byTrader].map(([trader, told]) =>
      rows(b(short(trader)), ...told.map((text) => `  ${text}`)),
    );
    if (fills.length > shown.length) body.push(`and ${fills.length - shown.length} more.`);

    const delivered = await post.sendMessage({
      chat_id: chatId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      text: lines(...body, html`${SITE}/p/${fills[0]?.trader ?? ''}`),
    });

    /*
     * Nothing is marked delivered unless it was.
     *
     * A failed send leaves every cursor where it was, so the next pass owes the
     * same fills and tries again. The alternative, advancing regardless, turns
     * one bad minute of Telegram's into fills nobody was ever told about.
     */
    if (delivered === null) {
      /*
       * A send that fails because the chat is gone will fail for ever.
       *
       * Somebody blocks the bot or removes it from a group, and the watch keeps
       * delivering into a room that will never accept another message: a failing
       * request every twenty seconds, indefinitely. The transport reports that
       * separately from a rate limit or an outage, and only that case drops the
       * watches.
       */
      if (post.chatGone?.(chatId)) await dropChat(client, chatId);
      continue;
    }

    sent += 1;
    // Advanced per watch, to the newest id that watch was actually told about,
    // which is not the same number for two watches in one message.
    const newest = new Map<number, number>();
    for (const fill of shown) {
      newest.set(fill.watchId, Math.max(newest.get(fill.watchId) ?? 0, fill.tradeId));
    }
    for (const [watchId, tradeId] of newest) await advanceWatch(client, watchId, tradeId);
  }

  void now;
  return sent;
}

let started = false;

export function startWatchNotifier(): void {
  if (started) return;

  const post = telegram();
  /*
   * Without a token there is nothing to deliver to, and running the pass anyway
   * would be a database query every twenty seconds whose entire result is
   * thrown away.
   */
  if (!post.live) {
    console.log('[telegram] no bot token: watches will not be delivered');
    return;
  }

  started = true;
  const tick = (): void => {
    void deliverWatches(post).catch((error) => {
      console.error('[telegram] delivery pass failed', error);
    });
  };
  setInterval(tick, CYCLE_MS).unref?.();
  tick();
}
