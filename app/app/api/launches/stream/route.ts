import type { Launch } from '@probatio/db';
import { PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { marketCapLamports, priceFromReserves } from '@probatio/candles';
import { subscribeToCurves, subscribeToLaunches } from '@/lib/launch-stream';
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
  // One connection costs a subscription slot, not a query, so the limit here
  // is against opening hundreds of them rather than against reading.
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

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
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener('abort', close);
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
