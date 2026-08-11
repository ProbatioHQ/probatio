import { lastLivePrice, onLivePrice } from '@/lib/price-stream';
import { noteViewed } from '@/lib/watched';
import { rateLimit } from '@/lib/rate-limit';

/**
 * A token's price, pushed as it changes.
 *
 * The chart polls for candles because history is a bounded thing worth asking
 * for. The current price is not: it changes when somebody trades, which is
 * whenever it wants to, and asking on a timer means being wrong for the length
 * of the timer. So this holds the connection open and writes a line whenever
 * the chain says the market moved.
 *
 * Asking for this stream is also what marks the token as being looked at, which
 * is what causes it to be subscribed to in the first place. A reader arriving
 * is the whole trigger.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Long enough to prove the connection is alive to a proxy that buys silence. */
const HEARTBEAT_MS = 25_000;

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const mint = new URL(request.url).searchParams.get('mint') ?? '';
  if (!MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint is required' }, { status: 400 });
  }

  noteViewed(mint);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const write = (event: string, payload: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // The client went away between the check and the write.
        }
      };

      // Whatever is already known, immediately. A chart that has just opened
      // should not have to wait for the next trade to show a live price.
      const known = lastLivePrice(mint);
      if (known) {
        write('price', {
          mint: known.mint,
          price: known.price.toString(),
          slot: known.slot,
          at: known.at,
        });
      }

      unsubscribe = onLivePrice((price) => {
        if (price.mint !== mint) return;
        write('price', {
          mint: price.mint,
          price: price.price.toString(),
          slot: price.slot,
          at: price.at,
        });
      });

      // Keeping the token in the watched set for as long as somebody is
      // connected. The set expires by design, and an open chart is exactly the
      // thing that should keep it from expiring.
      heartbeat = setInterval(() => {
        noteViewed(mint);
        write('tick', { at: Date.now() });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
    },

    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer will hold a stream until it is useless.
      'x-accel-buffering': 'no',
    },
  });
}
