import 'server-only';
import { ownerOfKey, type Client } from '@probatio/db';
import { db } from './db';

/**
 * Who is holding this key.
 *
 * The API a program talks to is not the API a browser talks to, and the
 * difference is not cosmetic. A browser presents a cookie the browser attached
 * on its own, which is why every mutating route on this site needs an origin
 * check: a form on someone else's page can make a browser send that cookie. A
 * program presents a header it had to be told to send, which nothing can make it
 * send by accident, so there is nothing here to forge across origins.
 *
 * What that buys is a smaller surface, not a laxer one. A key still identifies
 * exactly one wallet, still reaches only that wallet's account, and is checked
 * against the database on every single request so revocation is immediate rather
 * than eventual.
 */

export type Authenticated =
  | { readonly ok: true; readonly pubkey: string; readonly keyId: number }
  | { readonly ok: false; readonly status: number; readonly error: string };

const SCHEME = 'Bearer ';

/**
 * The key on a request, or nothing.
 *
 * Only the Authorization header. A key in a query string ends up in access logs,
 * in browser history and in the referrer sent to the next site somebody visits,
 * and offering that as a convenience would be offering a way to leak a trading
 * credential without noticing.
 */
function presented(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith(SCHEME)) return null;
  const key = header.slice(SCHEME.length).trim();
  return key.length > 0 ? key : null;
}

export async function authenticate(
  request: Request,
  now = Date.now(),
): Promise<{ readonly auth: Authenticated; readonly client: Client | null }> {
  const key = presented(request);
  if (key === null) {
    return {
      auth: {
        ok: false,
        status: 401,
        error:
          'Send your key as an Authorization header: `Authorization: Bearer pk_live_...`. Mint one at /strategies.',
      },
      client: null,
    };
  }

  const client = await db();
  const owner = await ownerOfKey(client, key, now);
  if (!owner) {
    /*
     * One message for "never existed" and "revoked" alike. Telling the two apart
     * would let somebody with a list of guesses learn which of them were once
     * real keys, and the holder of a revoked key already knows they revoked it.
     */
    return {
      auth: { ok: false, status: 401, error: 'That key is not valid. It may have been revoked.' },
      client,
    };
  }

  return { auth: { ok: true, pubkey: owner.userPubkey, keyId: owner.id }, client };
}

/** A refusal, in the shape every endpoint here answers in. */
export function refuse(status: number, error: string, detail?: string): Response {
  return Response.json({ error, ...(detail === undefined ? {} : { detail }) }, { status });
}
