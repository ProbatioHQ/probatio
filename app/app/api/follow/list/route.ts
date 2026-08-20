import { followerList, followingList, markFollowersSeen, newFollowerCount } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * Who follows a wallet, or who it follows.
 *
 * Public either way, because the record is public and an audience for a public
 * record is not a private fact. Nothing here is gated on being signed in.
 *
 * One exception, and it is a write rather than a read: a trader asking for
 * their own follower list has, by definition, just looked at it, so the mark
 * that answers "how many are new" moves forward here. Doing it on the read is
 * what stops the count needing a second request to dismiss it, and it cannot
 * be triggered for anybody else because it is keyed on the session.
 */

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const pubkey = url.searchParams.get('pubkey') ?? '';
  const kind = url.searchParams.get('kind') === 'following' ? 'following' : 'followers';

  if (!WALLET.test(pubkey)) {
    return Response.json({ error: 'not a wallet address' }, { status: 400 });
  }

  const client = await db();
  const entries =
    kind === 'following' ? await followingList(client, pubkey) : await followerList(client, pubkey);

  const user = await currentUser();
  if (kind === 'followers' && user?.pubkey === pubkey) {
    // Seen, because they are looking at it right now.
    await markFollowersSeen(client, pubkey, Date.now());
  }

  return Response.json({ kind, entries });
}

/** The badge: how many followers this trader has not seen yet. */
export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  // Not an error. A signed-out reader has no unseen followers, and a page that
  // shows the badge should not have to know whether anybody is signed in.
  if (!user) return Response.json({ newFollowers: 0 });

  return Response.json({ newFollowers: await newFollowerCount(await db(), user.pubkey) });
}
