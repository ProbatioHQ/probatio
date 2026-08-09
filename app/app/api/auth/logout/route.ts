import { rateLimit } from '@/lib/rate-limit';
import { endSession } from '@/lib/session';

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  await endSession();
  return Response.json({ ok: true });
}
