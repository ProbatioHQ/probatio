import { claimUpdate } from '@probatio/db';
import { db } from '@/lib/db';
import { HANDLERS } from '@/lib/telegram/handlers';
import { route } from '@/lib/telegram/router';
import { telegram } from '@/lib/telegram/transport';
import type { Update } from '@/lib/telegram/types';

/**
 * Where Telegram delivers.
 *
 * Three things this has to get right, and all three are the difference between
 * a bot and an incident.
 *
 * It has to prove the caller is Telegram. The URL is a secret of sorts, but
 * URLs leak into logs and proxies, so Telegram also sends a header it was given
 * at registration. Without checking it, anyone who learns the path can make the
 * bot say anything to anybody.
 *
 * It has to handle each update once. Telegram redelivers until the webhook
 * answers, and redelivers again if the answer was slow. A retried update is a
 * second trade, so the id is claimed in the database before anything is done
 * with it, and the claim is an insert rather than a read so two deliveries race
 * the primary key instead of each other.
 *
 * And it has to answer. Anything other than a prompt 200 is read as failure and
 * brings the same update back around, so the work is done and the response is
 * returned without ever letting an error escape.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const expected = process.env['TELEGRAM_WEBHOOK_SECRET'];

  /*
   * No secret configured means this endpoint is not ready to be trusted, so it
   * refuses everything. Failing closed matters more than being ready: an open
   * webhook is a bot anybody can drive.
   */
  if (!expected) return new Response('not configured', { status: 404 });

  const offered = request.headers.get('x-telegram-bot-api-secret-token');
  if (offered !== expected) return new Response('no', { status: 401 });

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    // Malformed, and retrying would produce the same thing. Answered so
    // Telegram stops rather than coming back for ever.
    return new Response('ok');
  }

  if (typeof update.update_id !== 'number') return new Response('ok');

  try {
    const client = await db();
    const first = await claimUpdate(client, update.update_id, Date.now());
    // Already handled. Not an error, and not worth doing twice.
    if (!first) return new Response('ok');

    await route(update, telegram(), HANDLERS);
  } catch (error) {
    /*
     * Answered anyway.
     *
     * A five hundred here means Telegram brings this update back, and whatever
     * failed will fail again, so the retry buys nothing and risks repeating any
     * part that did succeed. It is logged, and it stops.
     */
    console.error('[telegram] webhook failed', error);
  }

  return new Response('ok');
}
