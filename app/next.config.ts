import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * There were none, which matters more here than on most sites: this one asks
 * people to connect a wallet and sign. A page that can be framed can be framed
 * invisibly over something else, and a click aimed at a harmless button lands
 * on Connect instead — clickjacking a signature prompt is the whole attack.
 * `frame-ancestors 'none'` and `X-Frame-Options` close it, one for modern
 * browsers and one for the rest.
 *
 * The content policy is an allowlist of what this app genuinely needs, written
 * out rather than loosened until the errors stopped:
 *
 * - `img-src` has to accept any https host, because token pictures are on
 *   whatever host the token's creator chose. They are rendered, never fetched
 *   by this server, and never trusted for anything.
 * - `frame-src` names DEX Screener alone. That is the embedded TradingView
 *   chart, and nothing else may be framed.
 * - `connect-src 'self'` almost everywhere: the RPC, the price quote and the
 *   pair check are all called from the server, so the browser only needs this
 *   origin. `/verify` is the deliberate exception — see below.
 * - `object-src 'none'`, `base-uri 'self'` and `form-action 'self'` are the
 *   cheap ones that close whole classes of injection.
 *
 * Scripts and styles still need `unsafe-inline`, which is a real weakening and
 * is written down rather than hidden: the framework inlines hydration data and
 * style, and removing it means per-request nonces threaded through the
 * document. Worth doing, not done here.
 */

const isProduction = process.env.NODE_ENV === 'production';

/**
 * The one page that has to reach outside.
 *
 * `/verify` rebuilds a trading record in the reader's browser and compares it
 * against Solana — reading from an endpoint *they* choose, precisely so the
 * answer does not come through this server. A server that vouches for its own
 * records is the thing the whole design exists to avoid needing.
 *
 * Locking `connect-src` to `'self'` broke exactly that. The page still loaded
 * and still ran its local checks, so nothing looked wrong; the RPC step simply
 * reported that the reader's endpoint could not be reached, blaming them for a
 * refusal this site had issued. The central claim of the product was
 * unfulfilled in the one place a stranger would go to test it.
 *
 * So `https:` is allowed here, and only here. It cannot be an allowlist of
 * hosts: "an endpoint you choose" means any endpoint, and a list of approved
 * ones would put this server back in the middle of the answer.
 */
const VERIFY_CONNECT_SRC = isProduction
  ? "connect-src 'self' https:"
  : // A local validator is plain http on 127.0.0.1, so an https-only policy
    // made the verify page unusable against one — which is exactly the setup
    // anybody developing or self-hosting checks against first. Development
    // only; a deployed site still refuses everything but https.
    "connect-src 'self' https: http://127.0.0.1:* http://localhost:*";

const csp = [
  "default-src 'self'",
  // The dev server compiles in the browser and needs eval; production does not.
  isProduction
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Token art lives on hosts chosen by whoever launched the token.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Everything external is fetched server-side, so the browser needs no more
  // than this origin. `ws:` is the dev server's hot reload socket.
  isProduction ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
  // The embedded TradingView chart, and nothing else.
  'frame-src https://dexscreener.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nobody frames this. See above: a framed wallet prompt is the attack.
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Addresses and mints appear in paths. They should not leak to third parties
  // through a Referer header on an outbound click.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/** The same policy, with the verifier's outbound fetch permitted. */
const verifyCsp = csp
  .split('; ')
  .map((directive) =>
    directive.startsWith('connect-src') ? VERIFY_CONNECT_SRC : directive,
  )
  .join('; ');

const nextConfig: NextConfig = {
  // @probatio/sim ships raw TypeScript rather than a build artifact, so the
  // fill engine has exactly one compiled form and the tests, the replay
  // harness in step 11 and the running app all execute identical code.
  transpilePackages: [
    '@probatio/sim',
    '@probatio/db',
    '@probatio/auth',
    '@probatio/pools',
    '@probatio/candles',
    '@probatio/commit',
    '@probatio/trading',
  ],

  // Never advertise what is serving this.
  poweredByHeader: false,

  async headers() {
    const hsts = {
      key: 'Strict-Transport-Security',
      value: 'max-age=63072000; includeSubDomains; preload',
    };

    return [
      {
        source: '/:path*',
        headers: isProduction
          ? [
              ...securityHeaders,
              // Only over TLS, and only in production — sending this from a
              // local dev server would pin localhost to https in the browser.
              hsts,
            ]
          : securityHeaders,
      },
      {
        /*
         * Listed after the catch-all, and that order is the whole trick.
         *
         * Next applies every matching entry in turn, so for a repeated header
         * key the last match is the one that survives. Putting this first read
         * more naturally and did nothing at all: `/verify` kept serving the
         * site-wide `connect-src 'self'` and the page stayed broken while the
         * config looked correct. Checked by reading the header off the running
         * server rather than by reasoning about it.
         */
        source: '/verify',
        headers: isProduction
          ? [
              { key: 'Content-Security-Policy', value: verifyCsp },
              ...securityHeaders.filter((h) => h.key !== 'Content-Security-Policy'),
              hsts,
            ]
          : [
              { key: 'Content-Security-Policy', value: verifyCsp },
              ...securityHeaders.filter((h) => h.key !== 'Content-Security-Policy'),
            ],
      },
    ];
  },
};

export default nextConfig;
