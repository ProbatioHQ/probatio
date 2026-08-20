import { describe, expect, it } from 'vitest';
import { b, code, escapeHtml, html, lines, rows } from '../format';

/**
 * Two rules that fight each other, and the wrapper that lets both hold.
 *
 * Everything a person supplies has to be escaped, or a token called
 * "<b>free money</b>" formats half a message and one containing a stray angle
 * bracket stops the message sending at all. And everything this code produces
 * has to survive, or the bold tags are escaped along with it and the chat shows
 * the characters instead of the emphasis. That second one actually happened on
 * the first pass, which is why it is tested rather than assumed.
 */

describe('what gets escaped', () => {
  it('escapes a value somebody supplied', () => {
    expect(html`Bought ${'<b>free money</b>'}`).toBe('Bought &lt;b&gt;free money&lt;/b&gt;');
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  /*
   * The bug this was written after. `b()` returns markup, and escaping it again
   * put the literal characters <b> into the fill card.
   */
  it('leaves markup this module produced alone', () => {
    expect(html`Bought ${b('1 SOL')}`).toBe('Bought <b>1 SOL</b>');
    expect(html`Root ${code('abc')}`).toBe('Root <code>abc</code>');
  });

  it('escapes inside its own markup too', () => {
    expect(b('<script>')).toHaveProperty('value', '<b>&lt;script&gt;</b>');
    expect(code('a<b')).toHaveProperty('value', '<code>a&lt;b</code>');
  });

  it('takes a number or a bigint without complaint', () => {
    expect(html`fill #${7}`).toBe('fill #7');
    expect(html`${1_000_000_000n} lamports`).toBe('1000000000 lamports');
  });

  it('prints nothing for a missing value rather than the word undefined', () => {
    expect(html`trader ${''}`).toBe('trader ');
  });
});

describe('how paragraphs are joined', () => {
  /*
   * Telegram wraps to whatever the bubble is on that device. A paragraph
   * pre-broken at eighty characters and re-broken at forty comes out as a
   * ragged column of one-word orphans, which is what the first version did on
   * a phone.
   */
  it('puts a blank line between paragraphs and nothing inside one', () => {
    expect(lines('one', 'two')).toBe('one\n\ntwo');
    expect(rows('one', 'two')).toBe('one\ntwo');
  });

  /*
   * So a card can include a line conditionally without leaving a hole where it
   * would have been.
   */
  it('drops anything empty rather than leaving a gap', () => {
    expect(lines('one', '', null, false, undefined, 'two')).toBe('one\n\ntwo');
    expect(rows('one', '', 'two')).toBe('one\ntwo');
  });

  it('keeps markup when joining', () => {
    expect(rows(b('one'), 'two')).toBe('<b>one</b>\ntwo');
  });
});
