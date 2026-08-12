/**
 * Who is being limited.
 *
 * The header is the dangerous part. `x-forwarded-for` is a list that each proxy
 * appends to, and anything the client sent arrives at the front of it. Reading
 * the leftmost entry — which is the obvious thing, and what most examples do —
 * means an attacker sets the header themselves, gets a fresh bucket on every
 * request, and the limiter enforces nothing at all while appearing to work.
 *
 * So the client address is counted from the *right*, past exactly as many
 * proxies as are actually in front of this server. Entries to the left of that
 * are whatever the caller decided to claim and are ignored.
 *
 * Getting the hop count wrong is bad in both directions and the directions are
 * not symmetric: too many hops limits a shared proxy as one caller, too few
 * lets a caller pick their own key. Too many is the safe error, so the default
 * is one and it is stated rather than guessed at.
 *
 * Zero is its own case. It means nothing sits in front of this server, so every
 * header here is written by the caller and none of them can be believed — not
 * `x-forwarded-for`, and not the vendor headers either.
 */

export interface IdentityOptions {
  /** Proxies between the internet and this server. */
  readonly trustedProxies?: number;
}

const FORWARDED_FOR = 'x-forwarded-for';

export function clientAddress(
  headers: Headers,
  options: IdentityOptions = {},
): string | null {
  const trusted = Math.max(0, options.trustedProxies ?? 1);

  /*
   * No proxy means no trustworthy header, full stop.
   *
   * Every header below is written by a proxy. With none in front of this
   * server, all of them arrive exactly as the caller typed them — including
   * `x-real-ip` and `cf-connecting-ip`, which are only credible because an
   * edge normally overwrites them. Trusting those under `TRUSTED_PROXIES=0`
   * let a caller send a different one on every request, take a fresh bucket
   * each time, and reduce the limiter to decoration while it looked like it
   * was working.
   *
   * The honest answer here is that the caller cannot be identified from
   * headers, which falls through to the shared bucket below. That is
   * deliberately harsh and it is the right harshness: it lands on exactly the
   * deployment that has no way to tell callers apart.
   */
  if (trusted === 0) return null;

  const forwarded = headers.get(FORWARDED_FOR);
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    // Count in from the right, past the proxies we actually have. Anything
    // further left is whatever the caller chose to claim.
    //
    // A list shorter than the trusted hop count means the proxies that should
    // have prepended entries did not, so the whole header is the caller's to
    // write. Falling back to the leftmost entry here was the bug: it handed a
    // caller a fresh bucket per request under a direct-to-node deployment that
    // left TRUSTED_PROXIES at its default. Treat that as unidentifiable, the
    // same harshness as the no-proxy case, rather than trusting hop zero.
    const index = hops.length - 1 - (trusted - 1);
    const address = index >= 0 ? hops[index] : null;
    if (address) return normalize(address);
  }

  // Written by the edge rather than forwarded by it, which is why they are
  // credible at all — and only once there is an edge. See the guard above.
  for (const header of ['cf-connecting-ip', 'x-real-ip', 'x-vercel-forwarded-for']) {
    const value = headers.get(header);
    if (value) return normalize(value);
  }

  return null;
}

function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase();
  // IPv6-mapped IPv4 and bare IPv4 are the same caller.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(trimmed);
  if (mapped?.[1]) return mapped[1];
  // Strip a port if one came along.
  const withPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(trimmed);
  return withPort?.[1] ?? trimmed;
}

/**
 * The key a caller is limited on.
 *
 * A signed-in wallet is limited as itself rather than as its address. Two
 * traders behind one office connection are two callers, and one wallet moving
 * between networks is still one caller — neither of which is true if everything
 * is keyed on an address.
 *
 * An unidentifiable caller gets a single shared bucket rather than a free pass.
 * That is deliberately harsh: it means anyone who strips their address shares a
 * bucket with everyone else doing the same.
 */
export function callerKey(pubkey: string | null, address: string | null): string {
  if (pubkey) return `w:${pubkey}`;
  if (address) return `a:${address}`;
  return 'unknown';
}
