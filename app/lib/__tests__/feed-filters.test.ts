import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  matchesFilters,
  type FeedToken,
  type Filters,
} from '../feed-filters';

/**
 * Do the feed filters actually filter.
 *
 * Every case here is a token that should show and one that should not, under
 * one filter at a time, so a passing suite is the answer to "do they work"
 * rather than a claim about it.
 */

const NOW = 1_800_000_000; // unix seconds
const SOL_USD = 100; // round number keeps the market cap maths obvious

function token(overrides: Partial<FeedToken> = {}): FeedToken {
  return {
    name: 'Groove Valley Gorilla',
    symbol: 'GORILLA',
    launchedAt: NOW - 3_600, // an hour old
    image: 'https://example.invalid/g.png',
    progressBps: 5_000, // 50%
    marketCap: (50n * 1_000_000_000n).toString(), // 50 SOL = $5,000
    creatorLaunches: 1,
    ...overrides,
  };
}

function filters(overrides: Partial<Filters> = {}): Filters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

const ctx = { solUsd: SOL_USD, nowSeconds: NOW };

describe('the default filter', () => {
  it('shows everything', () => {
    expect(matchesFilters(token(), DEFAULT_FILTERS, ctx)).toBe(true);
    expect(matchesFilters(token({ marketCap: null, progressBps: null }), DEFAULT_FILTERS, ctx)).toBe(
      true,
    );
  });
});

describe('search by name', () => {
  it('keeps a token whose name or symbol matches a term', () => {
    expect(matchesFilters(token(), filters({ include: 'gorilla' }), ctx)).toBe(true);
    expect(matchesFilters(token({ name: 'Cat Coin', symbol: 'CAT' }), filters({ include: 'gorilla' }), ctx)).toBe(false);
  });

  it('matches on the symbol, not only the name', () => {
    expect(matchesFilters(token({ name: 'Something', symbol: 'PEPE' }), filters({ include: 'pepe' }), ctx)).toBe(true);
  });

  it('is case-insensitive and takes any of several terms', () => {
    expect(matchesFilters(token({ name: 'DogWifHat', symbol: 'WIF' }), filters({ include: 'cat, dog' }), ctx)).toBe(true);
  });
});

describe('hide by name', () => {
  it('drops a token matching an excluded term', () => {
    expect(matchesFilters(token({ name: 'Test Scam' }), filters({ exclude: 'scam' }), ctx)).toBe(false);
    expect(matchesFilters(token(), filters({ exclude: 'scam' }), ctx)).toBe(true);
  });

  it('lets exclude override include', () => {
    // A token matching both is hidden — exclude is the stronger rule.
    expect(matchesFilters(token({ name: 'Gorilla Scam' }), filters({ include: 'gorilla', exclude: 'scam' }), ctx)).toBe(false);
  });
});

describe('market cap', () => {
  it('hides tokens below the floor', () => {
    // 50 SOL * $100 = $5,000. Floor at $6,000 hides it.
    expect(matchesFilters(token(), filters({ minMarketCapUsd: 6_000 }), ctx)).toBe(false);
    expect(matchesFilters(token(), filters({ minMarketCapUsd: 4_000 }), ctx)).toBe(true);
  });

  it('hides tokens above the ceiling', () => {
    expect(matchesFilters(token(), filters({ maxMarketCapUsd: 4_000 }), ctx)).toBe(false);
    expect(matchesFilters(token(), filters({ maxMarketCapUsd: 6_000 }), ctx)).toBe(true);
  });

  it('keeps a token inside a min/max band', () => {
    expect(matchesFilters(token(), filters({ minMarketCapUsd: 4_000, maxMarketCapUsd: 6_000 }), ctx)).toBe(true);
  });

  it('does not judge a token whose curve has not been read', () => {
    // An unpriced curve in the new lane must not be swept out by a floor.
    expect(matchesFilters(token({ marketCap: null }), filters({ minMarketCapUsd: 6_000 }), ctx)).toBe(true);
  });

  it('is inert when no exchange rate is known', () => {
    // A wrong dollar figure is worse than no filter, so it stands down.
    expect(matchesFilters(token(), filters({ minMarketCapUsd: 6_000 }), { solUsd: null, nowSeconds: NOW })).toBe(true);
  });
});

describe('curve progress', () => {
  it('applies a floor and a ceiling in percent', () => {
    expect(matchesFilters(token({ progressBps: 5_000 }), filters({ minProgressPct: 60 }), ctx)).toBe(false);
    expect(matchesFilters(token({ progressBps: 5_000 }), filters({ minProgressPct: 40 }), ctx)).toBe(true);
    expect(matchesFilters(token({ progressBps: 5_000 }), filters({ maxProgressPct: 40 }), ctx)).toBe(false);
  });

  it('lets an unread curve through', () => {
    expect(matchesFilters(token({ progressBps: null }), filters({ minProgressPct: 90 }), ctx)).toBe(true);
  });
});

describe('age', () => {
  it('hides tokens younger than the floor', () => {
    // Ten minutes old, floor at thirty minutes.
    expect(matchesFilters(token({ launchedAt: NOW - 600 }), filters({ minAgeMin: 30 }), ctx)).toBe(false);
    expect(matchesFilters(token({ launchedAt: NOW - 3_600 }), filters({ minAgeMin: 30 }), ctx)).toBe(true);
  });

  it('hides tokens older than the ceiling', () => {
    // Two hours old, ceiling at thirty minutes.
    expect(matchesFilters(token({ launchedAt: NOW - 7_200 }), filters({ maxAgeMin: 30 }), ctx)).toBe(false);
    expect(matchesFilters(token({ launchedAt: NOW - 600 }), filters({ maxAgeMin: 30 }), ctx)).toBe(true);
  });
});

describe('creator launches', () => {
  it('hides a serial launcher above the ceiling', () => {
    expect(matchesFilters(token({ creatorLaunches: 14 }), filters({ maxCreatorLaunches: 3 }), ctx)).toBe(false);
    expect(matchesFilters(token({ creatorLaunches: 2 }), filters({ maxCreatorLaunches: 3 }), ctx)).toBe(true);
  });

  it('treats an unknown count as a first launch', () => {
    // A token with no count reads as one launch, not as a serial launcher.
    expect(matchesFilters(token({ creatorLaunches: undefined }), filters({ maxCreatorLaunches: 1 }), ctx)).toBe(true);
  });
});

describe('hide imageless', () => {
  it('drops tokens with no picture only when asked', () => {
    expect(matchesFilters(token({ image: null }), filters({ hideImageless: true }), ctx)).toBe(false);
    expect(matchesFilters(token({ image: null }), filters({ hideImageless: false }), ctx)).toBe(true);
  });
});

describe('several filters at once', () => {
  it('requires a token to pass every active one', () => {
    const strict = filters({ minMarketCapUsd: 4_000, minProgressPct: 40, maxCreatorLaunches: 3 });
    expect(matchesFilters(token(), strict, ctx)).toBe(true);
    // Fails one of the three — the whole thing fails.
    expect(matchesFilters(token({ creatorLaunches: 20 }), strict, ctx)).toBe(false);
  });
});

describe('activeFilterCount', () => {
  it('is zero for the default', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
  });

  it('counts each engaged filter once', () => {
    expect(activeFilterCount(filters({ include: 'cat', minMarketCapUsd: 5_000, hideImageless: true }))).toBe(3);
  });

  it('does not count a bound left at zero', () => {
    expect(activeFilterCount(filters({ minMarketCapUsd: 0, maxAgeMin: 0 }))).toBe(0);
  });
});
