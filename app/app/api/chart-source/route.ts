import { isDexIndexed } from '@/lib/dex-pairs';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Whether the embedded chart can draw this token yet.
 *
 * Polled by a token page that opened on the native chart because DEX Screener
 * had not indexed the pair. A token minutes old crosses that line while
 * somebody is looking at it, and the page should notice rather than making
 * them reload to find out.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const mint = new URL(request.url).searchParams.get('mint');
  if (!mint || !MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint address is required' }, { status: 400 });
  }

  return Response.json({ indexed: await isDexIndexed(mint) });
}
