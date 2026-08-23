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
  readonly nowMs: number;
}

/**
 * Whether a token survives a filter set.
 *
 * When a range is set, a token whose value is unknown is hidden, not shown. If
 * you ask for a market cap between five and fifty thousand, a token whose market
 * cap has not been read cannot be confirmed to be in that band, and showing it
 * anyway is what made a filtered bonded lane read as a column of "n/a" rows.
 * The earlier version let unknowns through so a filter would not empty the new
 * lane, but the lanes have their own filter sets now — filtering new by market
 * cap and getting nothing back is a coherent answer, because new tokens do not
 * have one yet.
 *
 * The one exception is the market cap filter with no exchange rate: dollars
 * cannot be computed at all, so it stands down entirely rather than hiding
 * everything.
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

  /*
   * Age is always known, and both sides are milliseconds.
   *
   * A seconds clock against a millisecond launch time is always negative, so
   * this was nought minutes for every token: a minimum age rejected everything
   * and a maximum age accepted everything.
   */
  const ageMin = Math.max(0, ctx.nowMs - token.launchedAt) / 60_000;
  if (filters.minAgeMin > 0 && ageMin < filters.minAgeMin) return false;
  if (filters.maxAgeMin > 0 && ageMin > filters.maxAgeMin) return false;

  if (filters.minProgressPct > 0 || filters.maxProgressPct > 0) {
    if (token.progressBps === null) return false;
    const pct = token.progressBps / 100;
    if (filters.minProgressPct > 0 && pct < filters.minProgressPct) return false;
    if (filters.maxProgressPct > 0 && pct > filters.maxProgressPct) return false;
  }

  if (filters.minMarketCapUsd > 0 || filters.maxMarketCapUsd > 0) {
    // No rate means no dollars, so the filter cannot run and does not hide.
    if (ctx.solUsd !== null) {
      if (!token.marketCap) return false;
      const usd = (Number(BigInt(token.marketCap)) / 1e9) * ctx.solUsd;
      if (filters.minMarketCapUsd > 0 && usd < filters.minMarketCapUsd) return false;
      if (filters.maxMarketCapUsd > 0 && usd > filters.maxMarketCapUsd) return false;
    }
  }

  return true;
}
