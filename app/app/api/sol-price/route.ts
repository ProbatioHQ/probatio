import { rateLimit } from '@/lib/rate-limit';
import { solUsd } from '@/lib/sol-price';

/**
 * What one SOL is worth, for rendering.
 *
 * Its own route because the figure it feeds — a market cap in dollars — moves
 * on a different clock from the tokens themselves. The feed streams token
 * changes continuously; the exchange rate needs re-reading about once a minute,
 * and pushing it down the token stream would mean sending it with every curve
 * update or not at all.
 *
 * Null is a valid answer. See lib/sol-price: a dollar figure is display only,
 * and no quote is better than an invented one.
 */
export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  return Response.json({ solUsd: await solUsd() });
}
