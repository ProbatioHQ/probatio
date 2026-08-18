import { ACCOUNT_COOKIE, type AccountMode } from '@/lib/account-choice';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * Choose which account to trade, when somebody has two.
 *
 * A preference of this browser's, not a change to anything owned: nothing moves
 * between the accounts and no balance is touched. It decides only where the
 * next trade lands, so it is a cookie and setting it is cheap.
 *
 * Signed in only. There is no second account to choose between otherwise, and a
 * cookie set by a stranger would be a preference nobody expressed.
 */
export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

  let mode: AccountMode;
  try {
    const body = (await request.json()) as { mode?: unknown };
    if (body.mode !== 'free' && body.mode !== 'ranked') {
      return Response.json({ error: 'mode must be free or ranked' }, { status: 400 });
    }
    mode = body.mode;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const response = Response.json({ mode });
  response.headers.append(
    'set-cookie',
    // Lax rather than strict: arriving from a link somebody shared should not
    // silently move them onto a different account than the one they chose.
    `${ACCOUNT_COOKIE}=${mode}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}` +
      (process.env.NODE_ENV === 'production' ? '; Secure' : ''),
  );
  return response;
}
