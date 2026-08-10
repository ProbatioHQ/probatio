import type { Launch } from '@probatio/db';
import { PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { marketCapLamports, priceFromReserves } from '@probatio/candles';
import { subscribeToCurves, subscribeToLaunches, takeStreamSlot } from '@/lib/launch-stream';
import { knownImages } from '@/lib/token-images';
import { rateLimit } from '@/lib/rate-limit';

/**
 * The launch feed as it happens.
 *
 * Server-sent events rather than a websocket: this only ever goes one way, and
 * SSE reconnects on its own without a line of client code to maintain.
 *
 * Held open for as long as the reader stays, which is why it must never be
 * pre-rendered and must never buffer.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A comment down the wire, often enough that proxies do not call it idle. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  // A rate limit does not bound this. A stream is held open, so the cost is
  // concurrency rather than frequency: one caller allowed 120 reads a minute
  // could hold 120 streams open forever and never ask for anything again.
  const slot = takeStreamSlot(throttled.key);
  if (!slot.granted) {
    return Response.json(
      { error: 'too many open streams from here' },
      { status: 429, headers: { 'retry-after': '30' } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const send = (event: string, payload: unknown): void => {
        if (!open) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // The reader went away between the check and the write.
          open = false;
        }
      };

      // Tells the client to stop showing a reconnecting state, and gives the
      // browser its retry interval.
      controller.enqueue(encoder.encode('retry: 4000\n\n'));
      send('ready', { ok: true });

      const unsubscribe = subscribeToLaunches((launches: readonly Launch[]) => {
        // A brand-new token has no picture yet — the document is published
        // after the mint exists. Whatever is already cached goes out now and
        // the client asks again for the rest.
        void knownImages(launches.map((launch) => launch.mint))
          .then((images) => {
            send(
              'launches',
              launches.map((launch) => ({
                mint: launch.mint,
                name: launch.name,
                symbol: launch.symbol,
                creator: launch.creator,
                launchedAt: launch.launchedAt,
                image: images.get(launch.mint) ?? null,
              })),
            );
          })
          .catch(() => undefined);
      });

      // Curve progress moves a token between lanes without anything new being
      // launched, so it is its own event. A reader that treated it as a launch
      // would show the same token in two columns at once.
      const unsubscribeCurves = subscribeToCurves((curves) => {
        send(
          'curves',
          curves.map((curve) => ({
            mint: curve.mint,
            progressBps: curve.progressBps,
            // Sent with every update rather than only on the first load, or a
            // curve event would arrive and blank the column it just moved.
            marketCap:
              curve.virtualSolReserves && curve.virtualTokenReserves && curve.virtualTokenReserves > 0n
                ? marketCapLamports(
                    priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves),
                    PUMPFUN_TOKEN_TOTAL_SUPPLY,
                  ).toString()
                : null,
            complete: curve.complete,
          })),
        );
      });

      const heartbeat = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          open = false;
        }
      }, HEARTBEAT_MS);

      const close = (): void => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeCurves();
        slot.release();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener('abort', close);
      // Already aborted before this ran — a client that hung up during the
      // handshake would otherwise hold a slot with nothing to release it.
      if (request.signal.aborted) close();
    },
    cancel() {
      // The runtime tears the stream down without an abort in some paths.
      slot.release();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx buffers by default, which turns a live stream into a file that
      // arrives all at once when it ends.
      'x-accel-buffering': 'no',
    },
  });
}
