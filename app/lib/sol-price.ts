import 'server-only';

/**
 * What one SOL is worth in dollars.
 *
 * DISPLAY ONLY, and the boundary is not a stylistic one. Every number this
 * project decides anything with — a fill, a balance, a ranking, a payout, a
 * committed record — is an integer count of lamports and stays that way. This
 * value never enters any of them. It exists because "12.3◎" is not how anybody
 * says how big a token is, and a market cap nobody can read is a market cap
 * nobody uses.
 *
 * Which is also why it is allowed to be unavailable. If no quote can be had the
 * caller gets null and the interface falls back to SOL, rather than showing a
 * dollar figure derived from a guess.
 *
 * Off chain, deliberately. The obvious on-chain answer is Pyth, and the legacy
 * SOL/USD price account is still there and still decodes cleanly — but it is
 * dead: its status reads "unknown" and its last publish slot is around 299
 * million against a chain past 438 million. It returns roughly $119 for a SOL
 * that trades at $77. An oracle that fails by going stale rather than by going
 * missing is worse than no oracle, because nothing about the read looks wrong.
 */

/** How long a quote is good for. SOL does not move enough in a minute to matter here. */
const TTL_MS = 60_000;
/** A slow quote must never hold up a page that does not need it. */
const TIMEOUT_MS = 4_000;

/**
 * Sanity bounds.
 *
 * Not a forecast — a guard. A malformed response, an HTML error page parsed as
 * JSON, or a units mix-up lands far outside this, and rendering a market cap
 * off by three orders of magnitude is worse than rendering none.
 */
const MIN_PLAUSIBLE = 1;
const MAX_PLAUSIBLE = 100_000;

interface Source {
  readonly name: string;
  readonly url: string;
  parse(body: unknown): number | null;
}

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * Two independent sources, tried in order.
 *
 * Jupiter first because it is Solana-native and prices against the same
 * liquidity the rest of this reads. Coinbase second because it is a completely
 * different kind of venue, so the two are unlikely to be wrong or down together.
 */
const SOURCES: Source[] = [
  {
    name: 'jupiter',
    url: `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
    parse: (body) => {
      const entry = (body as Record<string, { usdPrice?: number }>)[WSOL];
      return typeof entry?.usdPrice === 'number' ? entry.usdPrice : null;
    },
  },
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    parse: (body) => {
      const amount = (body as { data?: { amount?: string } }).data?.amount;
      const value = Number(amount);
      return Number.isFinite(value) ? value : null;
    },
  },
];

let cached: { usd: number; at: number } | null = null;
let inFlight: Promise<number | null> | null = null;

async function fetchFrom(source: Source): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const value = source.parse(await response.json());
    if (value === null || !Number.isFinite(value)) return null;
    if (value < MIN_PLAUSIBLE || value > MAX_PLAUSIBLE) {
      console.warn(`[sol-price] ${source.name} returned ${value}, outside plausible range`);
      return null;
    }
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The current quote, or null.
 *
 * Cached, and de-duplicated: a page that asks three times in one render causes
 * one request, not three.
 */
export async function solUsd(): Promise<number | null> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.usd;

  if (inFlight) return inFlight;

  inFlight = (async () => {
    for (const source of SOURCES) {
      const value = await fetchFrom(source);
      if (value !== null) {
        cached = { usd: value, at: Date.now() };
        return value;
      }
    }
    // Every source failed. The last good quote is better than nothing for a
    // while — but only for a while, and never forever.
    if (cached && Date.now() - cached.at < 10 * TTL_MS) return cached.usd;
    return null;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
