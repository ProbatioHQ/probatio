/**
 * The URL to actually put in an `<img src>`.
 *
 * Token metadata points overwhelmingly at `ipfs.io`, and ipfs.io refuses
 * browsers. Measured on a real token: the same CID returns 200 to a plain
 * request and 403 to one carrying a browser User-Agent and an image Accept
 * header. So every one of those pictures loaded when the server checked it and
 * failed in front of the person looking at the page, which is why a token could
 * show a picture on pump.fun and a broken square here.
 *
 * The CID is the file. Which gateway serves it is a delivery detail, so the
 * stored URL is left exactly as the launcher wrote it and the swap happens at
 * render time. That keeps the record honest, and means the day a gateway stops
 * working the fix is one constant rather than a migration over 42,000 rows.
 *
 * pump.mypinata.cloud is the default because it is the gateway these tokens
 * were uploaded through, so it holds them already and answers browsers.
 */

/** Gateways that will not serve a browser. Their CIDs are re-pointed. */
const REFUSES_BROWSERS = ['ipfs.io', 'dweb.link', 'cloudflare-ipfs.com'];

const GATEWAY = 'https://pump.mypinata.cloud/ipfs';

/** The CID out of any gateway URL or ipfs:// URI, or null if there is none. */
function cidOf(url: string): string | null {
  const ipfsScheme = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(url);
  if (ipfsScheme?.[1]) return ipfsScheme[1];

  try {
    const parsed = new URL(url);
    if (!REFUSES_BROWSERS.includes(parsed.hostname)) return null;
    const match = /^\/ipfs\/(.+)$/.exec(parsed.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function imageSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  const cid = cidOf(url);
  return cid ? `${GATEWAY}/${cid}` : url;
}
