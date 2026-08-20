import { follow, followCounts, isFollowing, unfollow } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * Following a trader, and unfollowing one.
 *
 * The whole feature in one route, because follow and unfollow are the same
 * decision in two directions and splitting them would mean two places to keep
 * the checks identical.
 *
 * Both return the resulting state rather than an acknowledgement, so the button
 * that called it can render from the answer instead of guessing what it did and
 * being wrong when two devices are open on the same profile.
 */

const MINT_LIKE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function resolve(request: Request): Promise<{ target: string } | { error: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: Response.json({ error: 'expected a JSON body' }, { status: 400 }) };
  }
  const target =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['pubkey'] : null;
  if (typeof target !== 'string' || !MINT_LIKE.test(target)) {
    // Checked here rather than trusted to the foreign key, because a malformed
    // address should be a clear 400 and not a constraint error from the driver.
    return { error: Response.json({ error: 'not a wallet address' }, { status: 400 }) };
  }
  return { target };
}

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to follow a trader' }, { status: 401 });

  const resolved = await resolve(request);
  if ('error' in resolved) return resolved.error;
  if (resolved.target === user.pubkey) {
    return Response.json({ error: 'you cannot follow yourself' }, { status: 400 });
  }

  const client = await db();
  try {
    await follow(client, user.pubkey, resolved.target, Date.now());
  } catch (error) {
    // The foreign key is the real gate: it refuses a wallet that has never
    // signed in, which is what stops a follower count being inflated from
    // addresses that do not exist.
    console.error('[follow] failed', error);
    return Response.json({ error: 'that wallet has no record here yet' }, { status: 404 });
  }

  return Response.json({
    following: true,
    counts: await followCounts(client, resolved.target),
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });

  const resolved = await resolve(request);
  if ('error' in resolved) return resolved.error;

  const client = await db();
  await unfollow(client, user.pubkey, resolved.target);
  return Response.json({
    following: false,
    counts: await followCounts(client, resolved.target),
  });
}

/** The state a profile needs: the counts, and whether the reader follows them. */
export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const target = new URL(request.url).searchParams.get('pubkey') ?? '';
  if (!MINT_LIKE.test(target)) {
    return Response.json({ error: 'not a wallet address' }, { status: 400 });
  }

  const client = await db();
  const user = await currentUser();
  return Response.json({
    counts: await followCounts(client, target),
    // Signed out is not following, rather than unknown: the button renders the
    // same either way and the sign-in prompt happens when it is pressed.
    following: user ? await isFollowing(client, user.pubkey, target) : false,
    self: user?.pubkey === target,
  });
}
