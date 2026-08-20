import { claimLinkCode } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';
import { telegram } from '@/lib/telegram/transport';

/**
 * Redeem a link code against the wallet that is signed in.
 *
 * This is the half Telegram cannot do. The bot knows who is typing; only the
 * site knows which wallet they hold, because only the site made them sign for
 * it. So the proof of ownership is the session, and the code is nothing more
 * than a token carried from one to the other.
 *
 * Rate limited like anything else that guesses: a code is eight characters from
 * an alphabet of thirty-two, which is fine against a person and not against a
 * loop.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'auth');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const code = (body as { code?: unknown })?.code;
  if (typeof code !== 'string' || code.trim().length < 4) {
    return Response.json({ error: 'a code is required' }, { status: 400 });
  }

  const outcome = await claimLinkCode(await db(), code, user.pubkey, Date.now());

  /*
   * Every refusal is named. "That code does not exist" and "that code has
   * expired" send somebody to different places, and a flow that only ever says
   * it failed is a flow people give up on.
   */
  if (outcome.status !== 'linked') {
    const said: Record<string, string> = {
      unknown: 'That code does not exist. Ask the bot for a new one with /link.',
      expired: 'That code has expired. Ask the bot for a new one with /link.',
      used: 'That code has already been used. Ask the bot for a new one with /link.',
      wallet_taken: 'This wallet is already connected to a different Telegram account.',
      telegram_taken: 'That Telegram account is already connected to a different wallet.',
    };
    return Response.json({ error: said[outcome.status] ?? 'That did not work.' }, { status: 409 });
  }

  /*
   * Told in the chat it started in.
   *
   * Somebody typed /link on their phone and finished in a browser, so the
   * confirmation belongs where they were waiting. Failing to send it does not
   * fail the link: the link is done, and the page will say so.
   */
  await telegram().sendMessage({
    chat_id: outcome.chatId,
    disable_web_page_preview: true,
    text: [
      'Linked.',
      '',
      'This Telegram now trades the same account as the site. Same balance, same',
      'positions, same record.',
    ].join('\n'),
  });

  return Response.json({ status: 'linked' });
}
