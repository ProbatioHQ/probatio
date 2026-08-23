import {
  mintStrategyKey,
  revokeStrategyKey,
  strategyKeys,
} from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * Minting and revoking the keys a program trades with.
 *
 * Signed in through the website, not through a key. A key cannot mint another
 * key, which keeps a leak to the damage it can do rather than letting it grow
 * itself a replacement that survives the revocation of the original.
 *
 * Cross-site requests are kept out by the session cookie being `SameSite=Lax`,
 * which is what every mutating route here relies on, including the one that
 * spends a balance. A bespoke origin check on this route and nothing else would
 * read as a defence and be a decoration.
 */

/** Enough keys for a laptop, a server and a spare, and not enough to be a list. */
const MAX_KEYS = 5;
const MAX_NAME = 40;

export async function GET(): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  const client = await db();
  const keys = await strategyKeys(client, user.pubkey);

  // Prefixes and dates only. The secrets are not here to be listed, because
  // they were never stored.
  return Response.json({
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      lastUsedAt: key.lastUsedAt,
      revokedAt: key.revokedAt,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const name = String((body as { name?: unknown }).name ?? '').trim().slice(0, MAX_NAME);
  if (name.length === 0) {
    return Response.json({ error: 'give the key a name so you can tell it apart later' }, { status: 400 });
  }

  const client = await db();
  const existing = await strategyKeys(client, user.pubkey);
  if (existing.filter((key) => key.revokedAt === null).length >= MAX_KEYS) {
    return Response.json(
      { error: `you already have ${MAX_KEYS} live keys. Revoke one before minting another.` },
      { status: 409 },
    );
  }

  const { key, row } = await mintStrategyKey(client, {
    userPubkey: user.pubkey,
    name,
    now: Date.now(),
  });

  /*
   * The one and only time the secret exists outside the caller's hands.
   *
   * Only its hash was stored, so this cannot be shown again and there is no
   * endpoint that could. Said in the response rather than only in the interface,
   * because whoever is reading this over HTTP is exactly the person who needs to
   * know they are looking at something unrecoverable.
   */
  return Response.json({
    key,
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    note: 'This is the only time this key is shown. Only its hash was stored, so it cannot be recovered. If you lose it, revoke it and mint another.',
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'write');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: 'which key?' }, { status: 400 });
  }

  const client = await db();
  const revoked = await revokeStrategyKey(client, user.pubkey, id, Date.now());
  if (!revoked) {
    // Same answer whether it belongs to somebody else or never existed.
    return Response.json({ error: 'no such key' }, { status: 404 });
  }

  return Response.json({ revoked: true });
}
