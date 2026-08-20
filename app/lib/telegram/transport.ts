import 'server-only';
import type {
  AnswerCallback,
  AnswerInline,
  EditMessage,
  SendMessage,
} from './types';

/**
 * Everything the bot can say, behind one interface.
 *
 * The point of the interface is that the token is not required to build any of
 * this. The router, the cards, the keyboards and every command can be written
 * and tested against a fake that records what would have been sent, and the
 * real transport is the only piece that needs a bot to exist. That ordering was
 * chosen deliberately: waiting on BotFather to start writing the bot would have
 * meant writing the bot untested and finding out in a live chat.
 *
 * It is also the seam where a refusal from Telegram stops being interesting.
 * Nobody is waiting on the reply to a message the way they wait on a fill, so a
 * send that fails is logged and dropped rather than thrown up into a webhook
 * that has already answered.
 */
export interface Telegram {
  sendMessage(message: SendMessage): Promise<number | null>;
  editMessageText(edit: EditMessage): Promise<boolean>;
  answerCallbackQuery(answer: AnswerCallback): Promise<boolean>;
  answerInlineQuery(answer: AnswerInline): Promise<boolean>;
  /** Whether a token is configured at all. */
  readonly live: boolean;
  /**
   * Whether the last send to this chat failed because the chat is gone.
   *
   * A distinction worth keeping. A rate limit or an outage is temporary and the
   * right response is to try again; being blocked or removed from a group is
   * permanent, and a subscription still delivering into that chat is a failing
   * request every twenty seconds for ever. Only the permanent case should tear
   * anything down.
   */
  chatGone?(chatId: number): boolean;
}

const API = 'https://api.telegram.org';

/** Telegram's own envelope. Every method returns this shape. */
interface ApiReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/**
 * The real thing.
 *
 * Every call is one POST and one read. No retries: Telegram is not the chain,
 * a dropped message is a message rather than a fill, and a bot that retries
 * into a rate limit makes its own outage. The one exception worth having later
 * is 429 with `retry_after`, which is a queue rather than a failure, and it is
 * not worth having until something is actually being throttled.
 */
class HttpTelegram implements Telegram {
  readonly live = true;
  readonly #token: string;
  /**
   * Chats Telegram has said are unreachable for good.
   *
   * Kept on the instance and read straight after a failed send, rather than
   * returned from it, so the interface stays four plain methods and only the
   * one caller that cares has to know about this at all.
   */
  readonly #gone = new Set<number>();

  constructor(token: string) {
    this.#token = token;
  }

  chatGone(chatId: number): boolean {
    return this.#gone.delete(chatId);
  }

  async #call<T>(method: string, body: unknown): Promise<T | null> {
    try {
      const response = await fetch(`${API}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // A webhook has already answered by the time these run. Waiting longer
        // than this achieves nothing except holding the process open.
        signal: AbortSignal.timeout(10_000),
      });
      const reply = (await response.json()) as ApiReply<T>;
      if (!reply.ok) {
        // The description is the useful part and the token must never be in a
        // log line, which is why the URL is not.
        console.warn(`[telegram] ${method} refused: ${reply.error_code} ${reply.description}`);
        this.#noteGone(body, reply);
        return null;
      }
      return reply.result ?? null;
    } catch (error) {
      console.warn(`[telegram] ${method} failed`, error);
      return null;
    }
  }

  /**
   * Telegram's way of saying a chat will never take another message.
   *
   * Four hundred and three is blocked, kicked, or deactivated. Four hundred is
   * mostly a bad request, so only the two descriptions that genuinely mean the
   * chat is gone count, and everything else is treated as temporary. Guessing
   * wrong in this direction silently unsubscribes somebody.
   */
  #noteGone(body: unknown, reply: ApiReply<unknown>): void {
    const chatId = (body as { chat_id?: unknown } | null)?.chat_id;
    if (typeof chatId !== 'number') return;

    const description = (reply.description ?? '').toLowerCase();
    const gone =
      reply.error_code === 403 ||
      description.includes('chat not found') ||
      description.includes('group chat was upgraded');
    if (gone) this.#gone.add(chatId);
  }

  async sendMessage(message: SendMessage): Promise<number | null> {
    const sent = await this.#call<{ message_id: number }>('sendMessage', message);
    return sent?.message_id ?? null;
  }

  async editMessageText(edit: EditMessage): Promise<boolean> {
    return (await this.#call('editMessageText', edit)) !== null;
  }

  async answerCallbackQuery(answer: AnswerCallback): Promise<boolean> {
    return (await this.#call('answerCallbackQuery', answer)) !== null;
  }

  async answerInlineQuery(answer: AnswerInline): Promise<boolean> {
    return (await this.#call('answerInlineQuery', answer)) !== null;
  }
}

/**
 * What the bot is without a token: silent, and honest about it.
 *
 * Not an error, because half of this exists to be built and tested before a
 * token has been issued. The webhook still parses, the router still routes and
 * every command still runs; the replies simply have nowhere to go.
 */
class SilentTelegram implements Telegram {
  readonly live = false;
  async sendMessage(): Promise<number | null> {
    return null;
  }
  async editMessageText(): Promise<boolean> {
    return false;
  }
  async answerCallbackQuery(): Promise<boolean> {
    return false;
  }
  async answerInlineQuery(): Promise<boolean> {
    return false;
  }
}

let cached: Telegram | null = null;

export function telegram(): Telegram {
  if (cached) return cached;
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  cached = token ? new HttpTelegram(token) : new SilentTelegram();
  return cached;
}

/** Records what would have been sent. The whole bot is tested against this. */
export class FakeTelegram implements Telegram {
  readonly live = true;
  readonly sent: SendMessage[] = [];
  readonly edited: EditMessage[] = [];
  readonly answered: AnswerCallback[] = [];
  readonly inline: AnswerInline[] = [];
  /** Chats a test wants sends to fail for, and those it wants declared dead. */
  readonly refusing = new Set<number>();
  readonly gone = new Set<number>();

  chatGone(chatId: number): boolean {
    return this.gone.has(chatId);
  }

  async sendMessage(message: SendMessage): Promise<number | null> {
    if (this.refusing.has(message.chat_id)) return null;
    this.sent.push(message);
    return this.sent.length;
  }
  async editMessageText(edit: EditMessage): Promise<boolean> {
    this.edited.push(edit);
    return true;
  }
  async answerCallbackQuery(answer: AnswerCallback): Promise<boolean> {
    this.answered.push(answer);
    return true;
  }
  async answerInlineQuery(answer: AnswerInline): Promise<boolean> {
    this.inline.push(answer);
    return true;
  }

  /** The text of the last thing said, which is what most assertions want. */
  last(): string | undefined {
    return this.sent[this.sent.length - 1]?.text;
  }
}
