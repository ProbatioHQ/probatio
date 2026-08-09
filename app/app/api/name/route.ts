import { activeName, claimName, clearName, nameRecord } from '@probatio/db';
import { DEFAULT_NAME_RULES, checkName } from '@probatio/profile';
import { db } from '@/lib/db';
import { currentUser } from '@/lib/session';

/**
 * Claiming a display name.
 *
 * A name is a convenience laid over a public key. It is never committed, never
 * hashed, and never part of a result — so it can be refused or taken away
 * without a single record moving.
 */

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to manage your name' }, { status: 401 });

  const client = await db();
  const record = await nameRecord(client, user.pubkey);

  return Response.json({
    name: await activeName(client, user.pubkey),
    cleared: record?.clearedAt !== null && record?.clearedAt !== undefined,
    clearedNote: record?.clearedNote ?? null,
  });
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to set a name' }, { status: 401 });

  let body: { name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  if (typeof body.name !== 'string') {
    return Response.json({ error: 'name must be a string' }, { status: 400 });
  }

  const checked = checkName(body.name, DEFAULT_NAME_RULES);
  if (!checked.ok) {
    return Response.json({ error: checked.detail, reason: checked.reason }, { status: 400 });
  }

  const client = await db();
  const outcome = await claimName(client, user.pubkey, checked.name, checked.key, Date.now());

  if (outcome === 'taken') {
    // Includes names that were moderated away. The string stays reserved;
    // handing it back would give it to whoever was waiting for it.
    return Response.json({ error: 'that name is not available', reason: 'taken' }, { status: 409 });
  }

  return Response.json({ name: checked.name, outcome });
}

export async function DELETE(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to remove your name' }, { status: 401 });

  const client = await db();
  // Giving up a name keeps it reserved, exactly as moderation does. Otherwise
  // releasing one is a way to park it for somebody else a second later.
  const removed = await clearName(client, user.pubkey, 'released by owner', Date.now());
  return Response.json({ removed });
}
