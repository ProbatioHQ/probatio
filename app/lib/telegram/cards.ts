import 'server-only';
import type { VerifyResult } from './verify';
import { b, code, html, lines } from './format';

/**
 * What a verified record looks like in a chat.
 *
 * The card has one job, which is to be the thing somebody screenshots instead
 * of the screenshot they were arguing about. So it leads with the verdict, it
 * names what was actually checked, and it prints the root, because the root is
 * the part a sceptic can go and recompute for themselves.
 *
 * Every interpolated value goes through `html`, which escapes it. A wallet or a
 * token name should never be able to turn half a message italic, or worse, fail
 * to send at all; escaping is the narrow fix for that, where refusing to format
 * anything was the blunt one.
 *
 * Paragraphs are single lines. Telegram wraps to the bubble, and a paragraph
 * pre-broken at eighty characters and re-broken at forty is a ragged column of
 * orphans on a phone.
 */

function short(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

const SITE = process.env['PROBATIO_SITE'] ?? 'https://probatiotrade.com';

export function verifyCard(result: VerifyResult): string {
  const { trader } = result;

  if (result.unreachable) {
    return lines(
      html`Could not read ${short(trader)} just now.`,
      'That is this bot failing to reach the record, not the record failing. Try again.',
    );
  }

  if (result.empty || !result.record) {
    return lines(
      html`${short(trader)} has no record on Probatio.`,
      'Nothing has been traded by this wallet here, so there is nothing to check. That is not an accusation, it is an absence.',
    );
  }

  const { record } = result;

  /*
   * The unhappy path first, because it is the one that matters and the one a
   * card like this exists to be able to say at all.
   */
  if (!record.verified) {
    return lines(
      `${b(`${short(trader)} does not verify.`)}`,
      `${b(`${record.broken.length} of ${record.tradeCount}`)} sealed fills no longer hash to the seal recorded beside them. Something was changed after the fill landed.`,
      html`${SITE}/p/${trader}`,
    );
  }

  return lines(
    `${b(`${short(trader)} verifies.`)}`,
    `${b(`${record.tradeCount} sealed fills`)}, every one recomputed from the figures it was priced against: the reserves, the amounts, the fee, the slot it was clicked at and the slot it filled at.`,
    `Root ${code(`${record.root.slice(0, 16)}…`)}`,
    'No RPC calls, no API key, and nothing taken on this bot’s word. The same code is public and gives anyone the same answer.',
    html`${SITE}/p/${trader}`,
  );
}

/** The one line version, for an inline result's preview. */
export function verdictLine(result: VerifyResult): string {
  if (result.unreachable) return 'Could not read that record just now';
  if (result.empty || !result.record) return 'No record on Probatio';
  if (!result.record.verified) {
    return `Does not verify: ${result.record.broken.length} of ${result.record.tradeCount} fills altered`;
  }
  return `Verifies: ${result.record.tradeCount} sealed fills, recomputed`;
}
