import { followedTrades, traderTrades, type FollowedTrade } from '@probatio/db';
import { db } from '@/lib/db';
import { takeStreamSlot } from '@/lib/launch-stream';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * Watching somebody trade, as it happens.
 *
 * Two modes on one route, because they differ only in which fills they select:
 * `?trader=<wallet>` watches one profile, and `?feed=following` watches
 * everybody the reader follows.
 *
 * Polled rather than pushed. The launch feed can subscribe in process because
 * it owns the socket the launches arrive on, but a fill is a row somebody else
 * wrote inside a transaction, and hooking the trade path to publish would put
 * this feature's failure modes inside the one path that must never break. A
 * query every two seconds against an indexed id is cheap, survives a restart
 * with no reconnect logic, and "live" at two seconds is live enough to watch
 * somebody work.
 *
 * The cursor is a trade id, never a timestamp. Two fills can share a
 * millisecond, and a timestamp cursor would either repeat one or lose it.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;
const POLL_MS = 2_000;
/** The backfill a spectator arrives to, so the panel is never empty. */
const INITIAL = 15;

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const trader = url.searchParams.get('trader');
  const wantsFeed = url.searchParams.get('feed') === 'following';

  if (!wantsFeed && (trader === null || !WALLET.test(trader))) {
    return Response.json({ error: 'pass a trader wallet, or feed=following' }, { status: 400 });
  }

  const user = await currentUser();
  if (wantsFeed && !user) {
    return Response.json({ error: 'sign in to watch who you follow' }, { status: 401 });
  }

  /*
   * A rate limit does not bound a held-open connection: the cost here is
   * concurrency, not frequency, so one caller allowed 120 reads a minute could
   * otherwise hold 120 streams open and never ask for anything again.
   */
  const slot = takeStreamSlot(throttled.key);
  if (!slot.granted) {
    return Response.json(
      { error: 'too many open streams from here' },
      { status: 429, headers: { 'retry-after': '30' } },
    );
  }

  const encoder = new TextEncoder();
  const watcher = wantsFeed ? null : trader;
  const reader = user?.pubkey ?? null;

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client went away between the check and the write.
          open = false;
        }
      };

      const read = async (after: number, limit: number): Promise<FollowedTrade[]> => {
        const client = await db();
        return watcher === null
          ? await followedTrades(client, reader ?? '', { after, limit })
          : await traderTrades(client, watcher, { after, limit });
      };

      controller.enqueue(encoder.encode('retry: 4000\n\n'));

      // Newest first out of the query, oldest first down the wire, so a client
      // can append every event the same way whether it is backfill or live.
      let cursor = 0;
      try {
        const initial = await read(0, INITIAL);
        cursor = initial.reduce((highest, trade) => Math.max(highest, trade.id), 0);
        send('ready', { ok: true, mode: watcher === null ? 'following' : 'trader' });
        send('fills', [...initial].reverse());
      } catch (error) {
        console.error('[spectate] initial read failed', error);
        send('ready', { ok: false, mode: watcher === null ? 'following' : 'trader' });
      }

      const poll = setInterval(() => {
        void read(cursor, 40)
          .then((fresh) => {
            if (fresh.length === 0) return;
            cursor = fresh.reduce((highest, trade) => Math.max(highest, trade.id), cursor);
            send('fills', [...fresh].reverse());
          })
          .catch((error: unknown) => {
            // One failed poll is not a reason to close a stream somebody is
            // watching. The next one carries whatever was missed, because the
            // cursor only advances on success.
            console.warn('[spectate] poll failed', error);
          });
      }, POLL_MS);

      // Proxies close a quiet connection, and a spectator watching somebody who
      // is not trading right now is exactly a quiet connection.
      const beat = setInterval(() => send('beat', { at: Date.now() }), HEARTBEAT_MS);

      cleanup = (): void => {
        open = false;
        clearInterval(poll);
        clearInterval(beat);
        slot.release();
      };
      request.signal.addEventListener('abort', () => {
        cleanup?.();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      });
    },
    cancel() {
      // Some runtimes cancel without firing abort. Without this the intervals
      // and the stream slot would outlive the connection.
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
