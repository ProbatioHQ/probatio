import 'server-only';

/**
 * Finding a token by name across all of pump.fun, not just what the feed caught.
 *
 * The launch feed only knows tokens it saw go live, so searching a name against
 * it misses everything older. pump.fun publishes no name API of its own, so an
 * outside index is the only way to turn a word into a mint address.
 *
 * Discovery only. The name and picture here are used to help someone find a
 * token and open its page; the price a trade fills at is still read from chain
 * at the moment of the fill, never from this. A wrong or stale entry here can
 * misname a row in a search result. It can never move a fill.
 */

export interface FoundToken {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly image: string | null;
  /** Market cap in US dollars, as the index reports it. Display only. */
  readonly marketCapUsd: number | null;
}

const SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search';
const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;
const CACHE_MAX = 500;

/** pump.fun's own venues on Solana, surfaced ahead of anything else. */
const PUMP_DEXES = new Set(['pumpfun', 'pumpswap']);

interface DexPair {
  chainId?: unknown;
  dexId?: unknown;
  baseToken?: { address?: unknown; name?: unknown; symbol?: unknown };
  info?: { imageUrl?: unknown };
  marketCap?: unknown;
  fdv?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reduce the index's pair list to distinct tokens, pump.fun ones first.
 *
 * The index answers with trading pairs, and one token has many, so it is
 * deduplicated by mint. Pure and separate from the fetch so it can be tested
 * against a recorded response without a network.
 */
export function parseTokens(body: unknown, query: string, limit: number): FoundToken[] {
  const pairs = (body as { pairs?: unknown } | null)?.pairs;
  if (!Array.isArray(pairs)) return [];

  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const pump: FoundToken[] = [];
  const other: FoundToken[] = [];

  for (const pair of pairs as DexPair[]) {
    if (pair?.chainId !== 'solana') continue;
    const address = pair.baseToken?.address;
    if (typeof address !== 'string' || seen.has(address)) continue;

    const name = typeof pair.baseToken?.name === 'string' ? pair.baseToken.name : address;
    const symbol = typeof pair.baseToken?.symbol === 'string' ? pair.baseToken.symbol : '';

    // The index also matches on the mint, so a token whose address happens to
    // contain the letters comes back for a search it has nothing to do with.
    // Keep only tokens whose name or symbol actually carries the query.
    if (
      needle.length > 0 &&
      !name.toLowerCase().includes(needle) &&
      !symbol.toLowerCase().includes(needle)
    ) {
      continue;
    }

    seen.add(address);
    const token: FoundToken = {
      mint: address,
      name,
      symbol,
      image: typeof pair.info?.imageUrl === 'string' ? pair.info.imageUrl : null,
      marketCapUsd: finiteNumber(pair.marketCap) ?? finiteNumber(pair.fdv),
    };
    (typeof pair.dexId === 'string' && PUMP_DEXES.has(pair.dexId) ? pump : other).push(token);
  }

  return [...pump, ...other].slice(0, limit);
}

const cache = new Map<string, { at: number; tokens: FoundToken[] }>();

/**
 * Search the outside index for tokens matching a name or symbol.
 *
 * Best effort throughout: a slow or failing index returns nothing rather than
 * breaking the search, which still has the local feed to fall back on. Results
 * are cached briefly so a burst of keystrokes and a crowd searching the same
 * word do not each become a call to the index.
 */
export async function searchExternalTokens(query: string, limit = 20): Promise<FoundToken[]> {
  const key = query.trim().toLowerCase();
  if (key.length === 0) return [];

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.tokens.slice(0, limit);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return hit?.tokens.slice(0, limit) ?? [];

    const tokens = parseTokens(await response.json(), query, 30);
    cache.set(key, { at: Date.now(), tokens });
    // Bounded, so a long tail of one-off searches cannot grow it without end.
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return tokens.slice(0, limit);
  } catch {
    // A timeout or an unreachable index is a search with fewer results, never a
    // failed one — the local feed results still stand.
    return hit?.tokens.slice(0, limit) ?? [];
  } finally {
    clearTimeout(timer);
  }
}
