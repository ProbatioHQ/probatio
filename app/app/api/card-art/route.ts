import { getTokenMetadata } from '@probatio/db';
import { db } from '@/lib/db';
import { imageSrc } from '@/lib/image-src';
import { BlockedAddressError, fetchPublic } from '@/lib/public-fetch';
import { rateLimit } from '@/lib/rate-limit';

/**
 * A token's own picture, served from this origin.
 *
 * Only here so that a card can be exported. A canvas that has drawn an image
 * from another origin is marked tainted by the browser and `toBlob` throws on
 * it, so token art fetched straight from a gateway can be shown and never
 * saved. Passing the same bytes through this origin removes the taint.
 *
 * TAKING A MINT INSTEAD OF A URL IS NOT ENOUGH
 *
 * The first version of this file said that accepting a mint rather than a URL
 * was the whole of the security design, and that no caller could compose a
 * request reaching somewhere of their choosing. That was wrong, and wrong in
 * the direction that matters.
 *
 * A token's picture address is written into its metadata by whoever launched
 * it, and launching a token is free. So the address is chosen by an attacker
 * after all — they simply choose it a step earlier, by minting a coin whose
 * image points at 169.254.169.254 or at something on the private network this
 * is deployed inside, and then asking this route for that mint.
 *
 * The site rendering the same URL in an `<img>` was never this problem: that
 * fetch happens on the trader's machine and reaches their network. Moving the
 * fetch to a server is what created it.
 *
 * So the address is checked as an address, in `fetchPublic`: https only, no
 * host that resolves to a private range, and no redirects, because a public
 * host answering 302 to a private one defeats a check made on the first URL
 * alone.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Nothing a token uses for art is anywhere near this. */
const MAX_BYTES = 4 * 1024 * 1024;

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const mint = new URL(request.url).searchParams.get('mint') ?? '';
  if (!MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint is required' }, { status: 400 });
  }

  const client = await db();
  const token = await getTokenMetadata(client, mint);
  const source = imageSrc(token?.imageUrl);
  if (!source) return Response.json({ error: 'no picture for that token' }, { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetchPublic(source);
  } catch (error) {
    /*
     * Told apart on purpose. "That address is not allowed" and "that address
     * did not answer" are a 400 and a 502, and collapsing them would hide a
     * token pointing somewhere it should not behind what reads as an outage.
     */
    if (error instanceof BlockedAddressError) {
      return Response.json({ error: 'that token’s picture is not fetchable' }, { status: 400 });
    }
    return Response.json({ error: 'could not fetch that picture' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: 'could not fetch that picture' }, { status: 502 });
  }

  /*
   * Only actual pictures come back out.
   *
   * The address came from metadata rather than from the caller, but what it
   * points at is still somebody else's server, and relaying whatever it decides
   * to answer with under this origin is how a proxy becomes a way to host
   * things here.
   */
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED.has(type)) {
    return Response.json({ error: 'that is not a picture' }, { status: 415 });
  }

  /*
   * Read with a ceiling rather than read and then measure.
   *
   * `content-length` is whatever the other end says, and the other end is a
   * server an attacker may own. Checking it and then calling `arrayBuffer`
   * anyway means a lying header buys an unbounded read into this process's
   * memory, which is the same denial of service the limit was added to prevent.
   */
  const body = upstream.body;
  if (!body) return Response.json({ error: 'could not fetch that picture' }, { status: 502 });

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return Response.json({ error: 'that picture is too large' }, { status: 413 });
      }
      chunks.push(value);
    }
  } catch {
    return Response.json({ error: 'could not fetch that picture' }, { status: 502 });
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  return new Response(bytes, {
    headers: {
      'content-type': type,
      // A token's art does not change, and a card being composed re-reads it.
      'cache-control': 'public, max-age=86400, immutable',
    },
  });
}
