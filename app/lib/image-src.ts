/**
 * The URL to actually put in an `<img src>`.
 *
 * Token images are content-addressed: the CID is the file, and which gateway
 * serves it is a delivery detail the launcher happened to write down. Those
 * gateways fail constantly and in ways that have nothing to do with the picture
 * still existing. Two measured on this site's own data:
 *
 *   ipfs.io refuses browsers. The same CID returns 200 to a plain request and
 *   403 to one carrying a browser User-Agent and an image Accept header, so
 *   every one of those pictures loaded when the server checked it and failed in
 *   front of the person looking at the page.
 *
 *   cf-ipfs.com no longer resolves at all. Cloudflare retired its gateway, and
 *   the URLs written while it was alive still sit in metadata that cannot be
 *   edited. Fifteen of the hundred and eighty tokens on the Explore board, one
 *   in twelve, were blank squares for that reason alone.
 *
 * So the gateway in the stored URL is not trusted, and no list of bad ones is
 * kept: any URL that names a CID is re-pointed, whichever host wrote it. A deny
 * list only ever describes the gateways that have already broken, which meant
 * finding out about each one from a screenshot of blank cards.
 *
 * Measured before being written this way: pump.mypinata.cloud served every CID
 * tried against it, including ones whose URLs pointed at cf-ipfs, myfilebase,
 * other pinata subdomains and ipfs.io. It is a gateway onto the same network,
 * not a private store, so a CID being reachable does not depend on who uploaded
 * it.
 *
 * The stored URL is left exactly as the launcher wrote it and the swap happens
 * at render time. That keeps the record honest, and means the day this gateway
 * stops working the fix is one constant rather than a migration over 42,000
 * rows.
 */

const GATEWAY = 'https://pump.mypinata.cloud/ipfs';

/**
 * The CID out of any gateway URL or ipfs:// URI, or null if there is none.
 *
 * Anything after the CID is kept: a URL can address a file inside a directory,
 * and dropping the path would resolve the directory listing instead of the
 * picture.
 */
function cidOf(url: string): string | null {
  const ipfsScheme = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(url);
  if (ipfsScheme?.[1]) return ipfsScheme[1];

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const match = /^\/ipfs\/(.+)$/.exec(parsed.pathname);
    if (!match?.[1]) return null;
    // The query is part of how some gateways address a file, so it travels
    // with the path rather than being dropped.
    return match[1] + parsed.search;
  } catch {
    return null;
  }
}

export function imageSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  const cid = cidOf(url);
  return cid ? `${GATEWAY}/${cid}` : url;
}
