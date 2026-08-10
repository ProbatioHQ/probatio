import { knownImages, resolveLaunchImages } from '@/lib/token-images';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Pictures for tokens that arrived over the stream.
 *
 * A token that launched a second ago has no picture yet, because the metadata
 * document is published separately from the mint. Rather than hold the feed
 * back for it, the row appears immediately with a mark drawn from its address
 * and the browser asks here a moment later.
 *
 * Only ever returns what is already cached. The fetch it kicks off is for the
 * next caller, so this route cannot be used to make the server pull arbitrary
 * URLs on demand and wait for them.
 */

const MAX_MINTS = 60;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const raw = new URL(request.url).searchParams.get('mints') ?? '';
  const mints = raw
    .split(',')
    .map((mint) => mint.trim())
    // Base58, and the right sort of length. A mint list is not free-form text.
    .filter((mint) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))
    .slice(0, MAX_MINTS);

  if (mints.length === 0) return Response.json({ images: {} });

  const images = await knownImages(mints);
  const missing = mints.filter((mint) => !images.has(mint));
  if (missing.length > 0) resolveLaunchImages(missing);

  return Response.json({ images: Object.fromEntries(images) });
}
