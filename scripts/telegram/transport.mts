import type { Telegram } from '../../app/lib/telegram/transport.ts';
import type {
  AnswerCallback,
  AnswerInline,
  EditMessage,
  InlineKeyboard,
  SendMessage,
} from '../../app/lib/telegram/types.ts';

/**
 * A Telegram that prints instead of sending.
 *
 * The fake the tests use records what would have been sent so it can be
 * asserted on. This one renders it, because a person reading a card is checking
 * something a test cannot: whether it is worth reading. Line breaks in the
 * wrong place, a number with fourteen decimals, a refusal that sounds like the
 * bot broke — all of it passes every assertion and is obvious the moment it is
 * laid out the way a chat would lay it out.
 *
 * It also keeps the buttons from the last message, so they can be pressed.
 * A keyboard that cannot be tapped is only half tested, and the ownership rule
 * on a callback is the part of this bot most worth driving by hand.
 */

const DIM = '[2m';
const BOLD = '[1m';
const MONO = '[36m';
const RESET = '[0m';

/**
 * Render what Telegram would render.
 *
 * The messages carry HTML now, and printing the tags defeats the point of this
 * whole harness: a card is being read here to judge whether it is worth
 * reading, and `&lt;b&gt;` in the middle of a sentence is not what anybody sees
 * in a chat. Bold becomes bold, monospace becomes a colour a terminal can show,
 * and the three escaped characters come back as themselves.
 */
function render(text: string): string {
  return text
    .replace(/<b>(.*?)<\/b>/gs, `${BOLD}$1${RESET}`)
    .replace(/<code>(.*?)<\/code>/gs, `${MONO}$1${RESET}`)
    .replace(/<a href="([^"]*)">(.*?)<\/a>/gs, `$2 ${DIM}($1)${RESET}`)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export interface Pressable {
  readonly label: string;
  readonly data: string;
}

export class PrintingTelegram implements Telegram {
  readonly live = true;
  /** The buttons on the most recent message, in the order they were printed. */
  buttons: Pressable[] = [];

  #render(text: string, markup: InlineKeyboard | undefined, label: string): void {
    console.log(`\n${DIM}${label}${RESET}`);
    for (const line of render(text).split('\n')) console.log(`  ${line}`);
    this.#renderButtons(markup);
  }

  #renderButtons(markup: InlineKeyboard | undefined): void {
    this.buttons = [];
    if (!markup) return;

    const rows: string[] = [];
    for (const row of markup.inline_keyboard) {
      const cells: string[] = [];
      for (const button of row) {
        if (button.callback_data) {
          this.buttons.push({ label: button.text, data: button.callback_data });
          cells.push(`[${this.buttons.length}] ${button.text}`);
        } else {
          // A link button cannot be pressed here, and saying so is better than
          // numbering it and having it do nothing.
          cells.push(`${DIM}[link] ${button.text}${RESET}`);
        }
      }
      rows.push(`  ${cells.join('   ')}`);
    }
    console.log(`${DIM}  ----${RESET}`);
    for (const row of rows) console.log(row);
  }

  async sendMessage(message: SendMessage): Promise<number | null> {
    const reply = message.reply_to_message_id === undefined ? '' : ' (as a reply)';
    this.#render(message.text, message.reply_markup, `bot -> chat ${message.chat_id}${reply}`);
    return 1;
  }

  async editMessageText(edit: EditMessage): Promise<boolean> {
    this.#render(edit.text, edit.reply_markup, `bot edits message ${edit.message_id}`);
    return true;
  }

  /*
   * Printed rather than swallowed, because the answer to a tap is a real reply
   * to the person who tapped: a toast, or a modal when it is a refusal worth
   * reading. A bot that answers every tap with nothing looks identical to one
   * that is broken.
   */
  async answerCallbackQuery(answer: AnswerCallback): Promise<boolean> {
    if (!answer.text) {
      console.log(`\n${DIM}bot answers the tap (no message)${RESET}`);
      return true;
    }
    console.log(
      `\n${DIM}bot answers the tap${answer.show_alert ? ' with an alert' : ''}${RESET}\n  ${BOLD}${render(answer.text)}${RESET}`,
    );
    return true;
  }

  async answerInlineQuery(answer: AnswerInline): Promise<boolean> {
    console.log(`\n${DIM}bot offers ${answer.results.length} inline result(s)${RESET}`);
    for (const result of answer.results) {
      console.log(`  ${BOLD}${result.title}${RESET}`);
      if (result.description) console.log(`  ${DIM}${result.description}${RESET}`);
      console.log(`${DIM}  ----${RESET}`);
      for (const line of render(result.input_message_content.message_text).split('\n')) {
        console.log(`  ${line}`);
      }
    }
    this.buttons = [];
    return true;
  }
}
