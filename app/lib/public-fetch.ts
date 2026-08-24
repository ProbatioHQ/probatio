import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Fetching an address somebody else chose, without fetching our own network.
 *
 * A token's picture is written into its metadata by whoever launched it, and
 * launching one is free. So any address in that field is an address an attacker
 * picked, and handing it to `fetch` on a server means asking that server to
 * make a request to somewhere inside its own deployment: the cloud provider's
 * metadata endpoint on 169.254.169.254, a database on the private network, a
 * health port bound to loopback. The browser rendering the same URL in an
 * `<img>` is not this problem, because the browser is on the trader's machine
 * and reaches their network rather than ours.
 *
 * Three things have to hold at once, and missing any one of them undoes the
 * other two:
 *
 *   The scheme must be https. Plain http on a chosen host is a downgrade
 *   somebody else controls.
 *
 *   The hostname must not resolve to a private address. Checked by resolving
 *   it here rather than by matching the name, because `internal.example.com`
 *   is a public name that can be pointed at 10.0.0.1 by whoever owns it.
 *
 *   Redirects must not be followed. A perfectly public host answering 302 to
 *   169.254.169.254 defeats a check made only on the first URL, which is the
 *   usual way this defence is written and the usual way it fails.
 */

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

/**
 * Whether an address belongs to a network nobody outside should reach.
 *
 * Written out rather than pulled from a library so that each range is
 * explicable. IPv6 matters as much as IPv4: `::ffff:10.0.0.1` is a v4 address
 * wearing a v6 hat, and a check that only knew about dotted quads would wave it
 * through.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true; // Not an address at all: refuse rather than guess.

  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this host"
    if (a === 169 && b === 254) return true; // link local, and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (lower.startsWith('fe80')) return true; // link local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('ff')) return true; // multicast
  // A v4 address mapped into v6 is still that v4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return false;
}

/**
 * Fetch a URL that somebody else chose, or refuse to.
 *
 * Refusing is a `BlockedAddressError` rather than a null, because the caller
 * has to be able to tell "that address is not allowed" from "that address did
 * not answer" — they are a 400 and a 502, and collapsing them hides a
 * misconfiguration behind what looks like somebody else's outage.
 */
export async function fetchPublic(
  raw: string,
  init: { readonly timeoutMs?: number } = {},
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddressError('that is not a URL');
  }

  if (url.protocol !== 'https:') {
    throw new BlockedAddressError('only https addresses are fetched');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new BlockedAddressError('that address is not reachable');
  } else {
    let resolved: { address: string }[];
    try {
      resolved = await lookup(host, { all: true });
    } catch {
      throw new BlockedAddressError('that host does not resolve');
    }
    /*
     * Every answer, not the first. A name that resolves to one public address
     * and one private one is a name that reaches the private one half the time,
     * and which half is not this code's decision to leave to chance.
     */
    if (resolved.length === 0 || resolved.some((entry) => isPrivateAddress(entry.address))) {
      throw new BlockedAddressError('that address is not reachable');
    }
  }

  return fetch(url, {
    // See the note above: a redirect is a second address nobody has checked.
    redirect: 'error',
    signal: AbortSignal.timeout(init.timeoutMs ?? 8_000),
    headers: { accept: 'image/*' },
  });
}
