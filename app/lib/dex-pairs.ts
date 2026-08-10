import 'server-only';

/**
 * Whether the embedded chart has anything to draw.
 *
 * The TradingView embed is served by DEX Screener, and they index a pump.fun
 * pair some minutes after it exists. For a token that launched thirty seconds
 * ago they have nothing, and the embed renders an empty frame saying so — on
 * exactly the tokens this site is most about.
 *
 * The native chart is the opposite. It is built from the launch feed's own
 * trade stream and a backfill of the token's first transactions, so a mint that
 * is a minute old already has candles with real bodies and real volume, while
 * a token with hours of history has only what we have watched.
 *
 * So neither is the right chart; which one is depends on the token's age. This
 * answers that question, and it is asked on the server so the first paint is
 * already correct rather than flipping under the reader.
 */

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens';
const TIMEOUT_MS = 3_500;

/**
 * Two cache lifetimes, and the difference matters.
 *
 * Indexed is effectively permanent — a pair does not stop existing — so it is
 * held for a long while. Not indexed is a statement about right now, on a token
 * that may well be indexed in a couple of minutes, so it expires quickly and is
 * asked again.
 */
const POSITIVE_TTL_MS = 30 * 60 * 1_000;
const NEGATIVE_TTL_MS = 60 * 1_000;
/** Bounded, so a long-running process does not remember every mint ever seen. */
const MAX_ENTRIES = 2_000;

const cache = new Map<string, { indexed: boolean; at: number }>();

function remember(mint: string, indexed: boolean): void {
  if (cache.size >= MAX_ENTRIES) {
    // Oldest insertion first, which is what a Map iterates in.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(mint, { indexed, at: Date.now() });
}

export async function isDexIndexed(mint: string): Promise<boolean> {
  const cached = cache.get(mint);
  if (cached) {
    const ttl = cached.indexed ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.indexed;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${ENDPOINT}/${encodeURIComponent(mint)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return false;

    const body = (await response.json()) as { pairs?: unknown[] | null };
    const indexed = Array.isArray(body.pairs) && body.pairs.length > 0;
    remember(mint, indexed);
    return indexed;
  } catch {
    // Unreachable is not the same as unindexed, and it is not cached as one.
    // The page falls back to the chart that needs nobody else.
    return false;
  } finally {
    clearTimeout(timer);
  }
}
