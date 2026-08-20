/**
 * The slice of Telegram's API this bot actually uses.
 *
 * Deliberately not the whole schema. Telegram's Update object has dozens of
 * optional branches, almost all of which this bot will never see, and typing
 * them all would be a large file that says nothing about what the bot does.
 * What is here is what the router reads; anything absent is a branch we ignore
 * on purpose, and it will be added when something needs it.
 */

export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly first_name?: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  /** 'private' is a direct message; everything else has other people in it. */
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
  readonly title?: string;
  readonly username?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly from?: TelegramUser;
  readonly chat: TelegramChat;
  readonly date: number;
  readonly text?: string;
  /**
   * The message this one replies to.
   *
   * Load-bearing: replying to somebody's screenshot with /verify is how the
   * feature is meant to be used, and the wallet comes from who they are rather
   * than from anything typed.
   */
  readonly reply_to_message?: TelegramMessage;
  readonly entities?: readonly { type: string; offset: number; length: number }[];
}

export interface CallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  /** Whatever the button was created with. Sixty-four bytes, Telegram's limit. */
  readonly data?: string;
}

export interface InlineQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly query: string;
  readonly offset: string;
}

export interface Update {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly callback_query?: CallbackQuery;
  readonly inline_query?: InlineQuery;
}

/** A button. Either it calls back, or it opens a link. */
export interface InlineButton {
  readonly text: string;
  readonly callback_data?: string;
  readonly url?: string;
}

export interface InlineKeyboard {
  readonly inline_keyboard: readonly (readonly InlineButton[])[];
}

export interface SendMessage {
  readonly chat_id: number;
  readonly text: string;
  readonly parse_mode?: 'HTML' | 'MarkdownV2';
  readonly reply_markup?: InlineKeyboard;
  readonly reply_to_message_id?: number;
  readonly disable_web_page_preview?: boolean;
}

export interface EditMessage {
  readonly chat_id: number;
  readonly message_id: number;
  readonly text: string;
  readonly parse_mode?: 'HTML' | 'MarkdownV2';
  readonly reply_markup?: InlineKeyboard;
}

export interface AnswerCallback {
  readonly callback_query_id: string;
  readonly text?: string;
  /** A modal rather than a toast. For refusals worth reading. */
  readonly show_alert?: boolean;
}

export interface InlineResultArticle {
  readonly type: 'article';
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly input_message_content: { message_text: string; parse_mode?: 'HTML' };
  readonly reply_markup?: InlineKeyboard;
}

export interface AnswerInline {
  readonly inline_query_id: string;
  readonly results: readonly InlineResultArticle[];
  /** Seconds Telegram may cache this answer. Zero for anything live. */
  readonly cache_time?: number;
  readonly is_personal?: boolean;
}
