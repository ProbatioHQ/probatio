/**
 * Deciding whether a token passes a lane's filters.
 *
 * Pulled out of the feed component so the decision is a pure function with no
 * React around it — which means it can be tested directly, which is the only
 * honest way to answer "do the filters actually work". The component keeps the
 * state and the panel; this holds the rule.
 */

export interface FeedToken {
  readonly name: string;
  readonly symbol: string;
  readonly launchedAt: number;
  readonly image: string | null;
  /** Basis points of the curve sold, or null when the curve has not been read. */
  readonly progressBps: number | null;
  /** Lamports as a digit string, or null when the curve has not been read. */
  readonly marketCap: string | null;
  /** A floor on how many tokens this creator has launched. */
  readonly creatorLaunches?: number;
}

/**
 * What the feed can be filtered on, and deliberately only what it knows.
 *
 * Market cap, curve progress, age and a creator's launch count are things this
 * feed actually measures from the launches it indexes and the curves it reads.
 * Holders, snipers and insider percentages are not, so there are no filters for
 * them. Every numeric bound uses 0 to mean "no bound", so an untouched filter
 * does nothing.
 */
export interface Filters {
  /** Comma-separated. A token must match at least one to show. Empty means all. */
  include: string;
  /** Comma-separated. A token matching any of these is hidden. */
  exclude: string;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minProgressPct: number;
  maxProgressPct: number;
  minAgeMin: number;
  maxAgeMin: number;
  /** 0 means no limit. Anything else hides serial launchers. */
  maxCreatorLaunches: number;
  hideImageless: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  include: '',
  exclude: '',
  minMarketCapUsd: 0,
  maxMarketCapUsd: 0,
  minProgressPct: 0,
  maxProgressPct: 0,
  minAgeMin: 0,
  maxAgeMin: 0,
  maxCreatorLaunches: 0,
  hideImageless: false,
};

/** Split a keyword box into lowercased terms, ignoring empties. */
export function keywords(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/** How many filters are actually doing something, for the panel's badge. */
export function activeFilterCount(filters: Filters): number {
  let n = 0;
  if (keywords(filters.include).length > 0) n += 1;
  if (keywords(filters.exclude).length > 0) n += 1;
  if (filters.minMarketCapUsd > 0) n += 1;
  if (filters.maxMarketCapUsd > 0) n += 1;
  if (filters.minProgressPct > 0) n += 1;
  if (filters.maxProgressPct > 0) n += 1;
  if (filters.minAgeMin > 0) n += 1;
  if (filters.maxAgeMin > 0) n += 1;
  if (filters.maxCreatorLaunches > 0) n += 1;
  if (filters.hideImageless) n += 1;
  return n;
}

export interface FilterContext {
  /** SOL in dollars, or null when no rate is known. */
  readonly solUsd: number | null;
  /** Current time in unix seconds, so the caller controls the clock. */
  readonly nowSeconds: number;
}

/**
 * Whether a token survives a filter set.
 *
 * A value the feed has not read yet — an unpriced curve in the new lane, where
 * that is normal — passes rather than being judged as zero, so a market cap or
 * progress floor does not silently empty the one lane that has no market caps.
 */
export function matchesFilters(token: FeedToken, filters: Filters, ctx: FilterContext): boolean {
  if (filters.hideImageless && !token.image) return false;

  const include = keywords(filters.include);
  const exclude = keywords(filters.exclude);
  if (include.length > 0 || exclude.length > 0) {
    // Name and symbol together, so "cat" finds a CAT ticker and a Cat Coin.
    const haystack = `${token.name} ${token.symbol}`.toLowerCase();
    if (include.length > 0 && !include.some((term) => haystack.includes(term))) return false;
    if (exclude.some((term) => haystack.includes(term))) return false;
  }

  if (
    filters.maxCreatorLaunches > 0 &&
    (token.creatorLaunches ?? 1) > filters.maxCreatorLaunches
  ) {
    return false;
  }

  // Age is always known.
  const ageMin = Math.max(0, ctx.nowSeconds - token.launchedAt) / 60;
  if (filters.minAgeMin > 0 && ageMin < filters.minAgeMin) return false;
  if (filters.maxAgeMin > 0 && ageMin > filters.maxAgeMin) return false;

  if (token.progressBps !== null) {
    const pct = token.progressBps / 100;
    if (filters.minProgressPct > 0 && pct < filters.minProgressPct) return false;
    if (filters.maxProgressPct > 0 && pct > filters.maxProgressPct) return false;
  }

  // Market cap needs the rate. An unread curve has no cap to judge.
  if ((filters.minMarketCapUsd > 0 || filters.maxMarketCapUsd > 0) && ctx.solUsd !== null) {
    if (token.marketCap) {
      const usd = (Number(BigInt(token.marketCap)) / 1e9) * ctx.solUsd;
      if (filters.minMarketCapUsd > 0 && usd < filters.minMarketCapUsd) return false;
      if (filters.maxMarketCapUsd > 0 && usd > filters.maxMarketCapUsd) return false;
    }
  }

  return true;
}
