import 'server-only';

/**
 * Which tokens somebody is looking at right now.
 *
 * The price watcher spends a fixed budget of RPC calls per pass and hands it to
 * whatever was read longest ago, which is the right rule for keeping a feed of
 * thousands honest and the wrong one for the single token filling somebody's
 * screen. A graduated token costs several calls to price — its pool has to be
 * searched for — so only four are done per pass and each is left alone for four
 * minutes afterwards. Fine for a lane of dashes. Not fine for a chart a trader
 * is watching, which needs to move while they watch it.
 *
 * So a token being viewed says so, and the watcher puts it first. The set is
 * small by construction: it holds what has been asked for in the last couple of
 * minutes and nothing else, so priority cannot be claimed by a token nobody is
 * looking at any more.
 *
 * Deliberately in memory rather than in the database. It is a fact about this
 * moment, it is worthless a minute later, and writing it down would put a row
 * per chart poll into the same database the trades live in.
 */

/** How long a view keeps a token in the priority set. */
const VIEW_TTL_MS = 2 * 60 * 1_000;
/** A ceiling, so a scripted sweep of the feed cannot claim the whole budget. */
const MAX_TRACKED = 64;

/**
 * Shared across bundles, for the reason in lib/health.ts: the route that marks
 * a token viewed and the watcher that reads the set compile into different
 * bundles, and a per-bundle copy means the watcher never sees a single view.
 */
const WATCHED_KEY = Symbol.for('probatio.watched-mints');

function store(): Map<string, number> {
  const global = globalThis as typeof globalThis & { [WATCHED_KEY]?: Map<string, number> };
  global[WATCHED_KEY] ??= new Map();
  return global[WATCHED_KEY];
}

/** Somebody asked for this token's chart. */
export function noteViewed(mint: string, now = Date.now()): void {
  const tracked = store();
  tracked.set(mint, now);

  if (tracked.size <= MAX_TRACKED) return;
  // Drop the coldest first. Sorting a map this small costs nothing and is
  // simpler to reason about than an eviction policy.
  const byAge = [...tracked].sort((left, right) => left[1] - right[1]);
  for (const [mint_] of byAge.slice(0, tracked.size - MAX_TRACKED)) {
    tracked.delete(mint_);
  }
}

/** Tokens viewed recently, most recent first. Expired entries are dropped. */
export function recentlyViewed(now = Date.now()): string[] {
  const tracked = store();
  const live: [string, number][] = [];

  for (const [mint, at] of tracked) {
    if (now - at > VIEW_TTL_MS) tracked.delete(mint);
    else live.push([mint, at]);
  }

  return live.sort((left, right) => right[1] - left[1]).map(([mint]) => mint);
}

/** For the health surface: how many charts are being watched right now. */
export function watchedCount(now = Date.now()): number {
  return recentlyViewed(now).length;
}
