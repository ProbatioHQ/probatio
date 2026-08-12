/**
 * Deciding whether a URI written on chain is safe for the server to fetch.
 *
 * The `uri` field of a metadata account is set by whoever launched the token.
 * Fetching it server-side hands an attacker a request originating from inside
 * our network, which is the classic setup for reaching a cloud instance's
 * credential endpoint, an internal admin service, or the local filesystem.
 *
 * So the rule here is an allowlist, not a blocklist: https only, public
 * hostnames only, no literal private address, and (checked at fetch time in
 * offchain.ts, using `addressIsPrivate` here) no public hostname that actually
 * resolves to a private address.
 */

export class UnsafeUriError extends Error {
  constructor(
    message: string,
    readonly uri: string,
  ) {
    super(message);
    this.name = 'UnsafeUriError';
  }
}

/**
 * The gateway used to resolve ipfs:// URIs.
 *
 * pump.fun pins its metadata to IPFS, and most tokens carry an ipfs:// URI or
 * an already-resolved gateway URL.
 */
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // The cloud instance metadata endpoint, by name as well as by address.
  'metadata.google.internal',
  'metadata.goog',
]);

/** Literal IPv4 in a private, loopback, link-local or reserved range. */
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((n) => Number.isNaN(n) || n > 255)) return false;

  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/**
 * Whether a resolved IP address (v4 or v6) is one a server must not fetch.
 *
 * The literal-hostname checks above stop a URI that names a private address
 * outright. This is the same judgment applied to what a public hostname
 * actually resolves to, which is where the real SSRF hides: `evil.example.com`
 * with an A record pointing at 169.254.169.254 passes every string check.
 */
export function addressIsPrivate(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';

  // IPv4-mapped and NAT64-embedded IPv6 carry a v4 address in the tail; judge it
  // as the v4 it is.
  const mapped = /(?:^::ffff:|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);

  if (!ip.includes(':')) return isPrivateIpv4(ip);

  // IPv6.
  if (ip === '::1' || ip === '::') return true; // loopback, unspecified
  if (ip.startsWith('fe80')) return true; // link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique local fc00::/7
  if (ip.startsWith('ff')) return true; // multicast
  return false;
}

/**
 * Whether the host is an IPv6 literal.
 *
 * All of them are refused, rather than only the private ranges. IPv6 offers too
 * many ways to write the same address for a denylist to be trustworthy: `::1`
 * compresses, `::ffff:127.0.0.1` is normalized by the URL parser into
 * `::ffff:7f00:1` before any check sees it, and NAT64 prefixes map the entire
 * IPv4 space into IPv6. Enumerating that safely is a losing game, and no real
 * metadata gateway is addressed by a bare IPv6 literal — every one of them has
 * a hostname.
 *
 * This was found by a test asserting `::ffff:127.0.0.1` was blocked. It was not.
 */
function isIpv6Literal(hostname: string): boolean {
  return hostname.startsWith('[') || hostname.includes(':');
}

/**
 * Normalize a metadata URI into something safe to fetch, or explain why it is
 * not.
 */
export function resolveMetadataUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) {
    throw new UnsafeUriError('metadata uri is empty', uri);
  }

  const candidate = trimmed.startsWith('ipfs://')
    ? `${IPFS_GATEWAY}${trimmed.slice('ipfs://'.length).replace(/^ipfs\//, '')}`
    : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new UnsafeUriError('metadata uri is not a valid URL', uri);
  }

  // https only. http would be downgradeable in transit, and file:, data: and
  // the rest have no business being fetched by a server.
  if (parsed.protocol !== 'https:') {
    throw new UnsafeUriError(`refusing to fetch a ${parsed.protocol} uri`, uri);
  }

  if (parsed.username || parsed.password) {
    throw new UnsafeUriError('refusing a uri carrying credentials', uri);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new UnsafeUriError(`refusing to fetch from ${hostname}`, uri);
  }
  if (isIpv6Literal(hostname)) {
    throw new UnsafeUriError(`refusing to fetch from the IPv6 literal ${hostname}`, uri);
  }
  if (isPrivateIpv4(hostname)) {
    throw new UnsafeUriError(`refusing to fetch from the private address ${hostname}`, uri);
  }
  // A bare hostname with no dot is an internal name on most networks.
  if (!hostname.includes('.')) {
    throw new UnsafeUriError(`refusing to fetch from the non-public hostname ${hostname}`, uri);
  }

  return parsed.toString();
}

/** Whether a URI is safe to fetch, without throwing. */
export function isFetchableUri(uri: string): boolean {
  try {
    resolveMetadataUri(uri);
    return true;
  } catch {
    return false;
  }
}
