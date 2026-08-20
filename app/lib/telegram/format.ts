import 'server-only';

/**
 * Writing a message a phone will render well.
 *
 * TWO THINGS THAT WERE WRONG
 *
 * Every message was hard-wrapped at about eighty characters, the width of the
 * editor they were written in. Telegram then wraps again, to whatever the
 * bubble happens to be on that device, so a paragraph broken at eighty and
 * re-broken at forty comes out as a ragged column with one-word orphans on
 * every other line. On the phone it read as a bug, which it was.
 *
 * So a paragraph is one line here, however long, and the blank line between
 * paragraphs is the only break that survives. The device decides the rest,
 * because only the device knows how wide it is.
 *
 * The other was aligning a command list with spaces. Telegram renders in a
 * proportional font, so a run of spaces lines nothing up; it just moves the
 * ragged edge somewhere else. Anything that needs to be a column has to say so.
 *
 * WHY HTML, AFTER SAYING PLAIN TEXT
 *
 * The original rule was that a mint containing an underscore should never be
 * able to italicise half a message or fail to send. That rule was right and it
 * is kept, but the way it was kept was too blunt: refusing all formatting also
 * gave up bold on the number that matters and monospace on the address somebody
 * is about to copy.
 *
 * The narrower fix is to escape, and to make escaping the thing that happens by
 * default rather than the thing you remember. `html` is a tagged template: the
 * literal parts are markup the author wrote, every interpolated value is
 * escaped on the way in. Getting an unescaped address into a message now takes
 * deliberate effort rather than forgetting.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** The three characters Telegram's HTML parser reads as markup. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ESCAPES[character] ?? character);
}

/**
 * Markup this module produced, as opposed to a value somebody supplied.
 *
 * Without the distinction, escaping everything means escaping the bold tags
 * too: `html`&#96;Bought ${'${b(amount)}'}&#96;` renders the characters
 * &lt;b&gt; in the chat instead of emboldening anything, which is exactly what
 * it did on the first pass. A branded wrapper is what lets one function escape
 * a token name and pass a bold tag through, without either being a judgement
 * call at the call site.
 */
class Safe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Markup = string | Safe | number | bigint;

function render(value: unknown): string {
  return value instanceof Safe ? value.value : escapeHtml(String(value ?? ''));
}

/**
 * A message, with every supplied value escaped and every produced tag kept.
 *
 * `html`&#96;Bought ${'${name}'}&#96; sends a token called &lt;b&gt;oops&lt;/b&gt;
 * as literal characters, which is what makes an arbitrary name safe to print.
 */
export function html(parts: TemplateStringsArray, ...values: Markup[]): string {
  return parts.reduce((text, part, index) => {
    return text + (index === 0 ? '' : render(values[index - 1])) + part;
  }, '');
}

/** Bold. For the one number in a message that somebody is looking for. */
export function b(value: Markup): Safe {
  return new Safe(`<b>${render(value)}</b>`);
}

/**
 * Monospace, and tap-to-copy on every Telegram client.
 *
 * For anything somebody is going to paste somewhere else: a wallet, a mint, a
 * link code. It is also the only way to get a column to line up, since the
 * default font is proportional.
 */
export function code(value: Markup): Safe {
  return new Safe(`<code>${render(value)}</code>`);
}

/**
 * Join paragraphs.
 *
 * One line each, a blank line between. Empty entries are dropped so a card can
 * include a line conditionally without leaving a hole where it would have been.
 */
export function lines(...paragraphs: (Markup | null | false | undefined)[]): string {
  return paragraphs
    .filter((line) => Boolean(line) && String(line) !== '')
    .map((line) => String(line))
    .join('\n\n');
}

/**
 * A list where every row is one line, no blank lines between.
 *
 * For a command menu or a list of positions, which read as a block rather than
 * as separate thoughts.
 */
export function rows(...items: (Markup | null | false | undefined)[]): string {
  return items
    .filter((line) => Boolean(line) && String(line) !== '')
    .map((line) => String(line))
    .join('\n');
}
