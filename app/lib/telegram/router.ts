import 'server-only';
import type { Telegram } from './transport';
import type { CallbackQuery, InlineQuery, TelegramMessage, Update } from './types';

/**
 * Where an update goes.
 *
 * One function, four kinds of thing arriving: a message, a tap on a button, an
 * inline query typed in a chat this bot has never been added to, and everything
 * else, which is ignored.
 *
 * The commands themselves are not here. This decides what an update is and
 * hands it to something that knows what to do with it, which keeps the parsing
 * separate from the trading and lets both be tested on their own.
 */

export interface Context {
  readonly telegram: Telegram;
  /** Telegram's id for the chat, which is what a reply is addressed to. */
  readonly chatId: number;
  /** The person, which is what an account is linked to. Absent in a channel. */
  readonly userId: number | null;
  readonly messageId: number;
  readonly isPrivate: boolean;
  /** The message being replied to, when there is one. `/verify` needs it. */
  readonly replyTo: TelegramMessage | null;
  readonly now: number;
}

export interface Command {
  /** Without the slash, lower case, and without the @botname suffix. */
  readonly name: string;
  /** Everything after the command, trimmed. Empty string when there was none. */
  readonly args: string;
}

export type CommandHandler = (context: Context, command: Command) => Promise<void>;
export type CallbackHandler = (context: Context, data: string, query: CallbackQuery) => Promise<void>;
export type InlineHandler = (telegram: Telegram, query: InlineQuery) => Promise<void>;

export interface Handlers {
  readonly commands: Readonly<Record<string, CommandHandler>>;
  /** Keyed by the part of the callback data before the first colon. */
  readonly callbacks: Readonly<Record<string, CallbackHandler>>;
  readonly inline?: InlineHandler;
  /** Anything typed that is not a command, in a direct message only. */
  readonly plain?: CommandHandler;
}

/**
 * Pull a command out of a message.
 *
 * Telegram writes `/verify@probatio_bot 4kj…` in a group, because several bots
 * can be listening and the suffix is how one is addressed. Stripping it is not
 * optional: without it every command in every group silently does nothing.
 *
 * A command has to start the message. `look at /verify` is somebody talking
 * about the bot, not talking to it.
 */
export function parseCommand(text: string | undefined): Command | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();

  const at = head.indexOf('@');
  const name = (at === -1 ? head.slice(1) : head.slice(1, at)).toLowerCase();
  if (name === '') return null;

  return { name, args };
}

function contextOf(telegram: Telegram, message: TelegramMessage, now: number): Context {
  return {
    telegram,
    chatId: message.chat.id,
    userId: message.from?.id ?? null,
    messageId: message.message_id,
    isPrivate: message.chat.type === 'private',
    replyTo: message.reply_to_message ?? null,
    now,
  };
}

/**
 * Handle one update.
 *
 * Never throws. A webhook that throws is a webhook Telegram retries, and a
 * retried update is a second trade: the failure of one command must not turn
 * into a duplicate of another. Anything that goes wrong is logged here and the
 * update is considered handled, because it was.
 */
export async function route(
  update: Update,
  telegram: Telegram,
  handlers: Handlers,
  now = Date.now(),
): Promise<void> {
  try {
    if (update.inline_query) {
      await handlers.inline?.(telegram, update.inline_query);
      return;
    }

    if (update.callback_query) {
      const query = update.callback_query;
      const data = query.data ?? '';
      const key = data.split(':')[0] ?? '';
      const handler = handlers.callbacks[key];

      if (!handler || !query.message) {
        // Every tap is answered, always. An unanswered callback leaves the
        // button spinning on the sender's phone until Telegram times it out.
        await telegram.answerCallbackQuery({ callback_query_id: query.id });
        return;
      }

      await handler(contextOf(telegram, query.message, now), data, query);
      return;
    }

    const message = update.message;
    if (!message) return;

    const command = parseCommand(message.text);
    if (command) {
      const handler = handlers.commands[command.name];
      if (handler) {
        await handler(contextOf(telegram, message, now), command);
        return;
      }
      /*
       * An unknown command is answered in a direct message and ignored in a
       * group. In a group it is almost always somebody else's bot being
       * addressed, and a room full of bots all saying they did not understand
       * is why people remove bots.
       */
      if (message.chat.type === 'private') {
        await telegram.sendMessage({
          chat_id: message.chat.id,
          text: `I do not know /${command.name}. Try /help.`,
        });
      }
      return;
    }

    // Plain text, direct messages only, for the same reason.
    if (message.chat.type === 'private' && handlers.plain) {
      await handlers.plain(contextOf(telegram, message, now), { name: '', args: message.text ?? '' });
    }
  } catch (error) {
    console.error('[telegram] update failed', error);
  }
}
