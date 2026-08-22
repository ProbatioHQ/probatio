/**
 * One budget for the whole process, shared by every background reader.
 *
 * WHAT WENT WRONG
 *
 * Each worker in this app is individually well behaved. The chart warmer paces
 * itself at fifty milliseconds, the wallet walker at forty-five, the price
 * marker at two hundred, the house accounts at a hundred and fifty, and every
 * one of them has retries, backoff, and an honest reason for the number it
 * chose. And that is exactly the problem: pacing is per client, so what the
 * endpoint sees is the sum of a dozen well behaved workers, which came to
 * roughly ninety-six requests a second.
 *
 * The plan those requests were drawn against allows ten million credits a
 * month. That is three point eight six credits a second, sustained, for
 * everything the site does. Ninety-six against three point eight six is not a
 * spike to be smoothed out; it is twenty-five times the budget, and it emptied
 * a month of credits in under a week. The provider then halted the account, and
 * the symptom was every worker failing at once with 429, the health probe's own
 * getSlot failing with 429, and the site truthfully reporting that it could not
 * read the chain, while nothing was wrong with the chain at all.
 *
 * A rate limiter would not have saved this. Spacing requests out changes when
 * credits are spent, not how many. So the limit here is a rate derived from the
 * allowance: what the plan affords per second, which is the only pace that can
 * be kept up for a month.
 *
 * WHAT IT DOES
 *
 * It spends at the rate the plan can afford. The allowance is configuration
 * rather than a constant, because it is a fact about a subscription and it
 * changes when the subscription does. Background readers share whatever
 * fraction of it is not held back for people.
 *
 * It counts what a call actually costs. Not every request is one credit: the
 * calls that walk a wallet's history or scan a program's accounts cost many
 * times a plain account read, and a budget that counted requests would be
 * wrong by exactly the amount that matters.
 *
 * It finds the ceiling rather than being told it. The allowance is what is
 * paid for; the endpoint decides what it will actually serve at any moment. So
 * the gap widens whenever a request is refused and narrows again after a long
 * run of successes: fast to retreat, slow to advance, which is the only way
 * round that settles.
 *
 * And it retreats together. Before this, a refusal taught one client to back
 * off while eleven others carried on into the same wall, which is how a limit
 * becomes an outage. One refusal now pauses every background reader.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * Interactive reads do not pass through it. Somebody clicking buy is waiting,
 * their traffic is a rounding error next to the sweeps, and the entire point of
 * throttling background work is that the request path keeps working while it
 * happens. A trader being told the chain is unreadable because the chart warmer
 * was busy is the failure this exists to prevent.
 *
 * Their refusals still count, though. A 429 on the request path is the
 * strongest evidence there is that the sweeps need to get out of the way, and
 * ignoring it would leave the one caller that must not be slowed down as the
 * one caller whose pain teaches nothing.
 */

export type RpcPriority = 'interactive' | 'background';

/**
 * What the plan allows in a month.
 *
 * Configuration, not a constant: it is a fact about a subscription, it changes
 * when the subscription does, and the whole failure above came from nothing in
 * the code knowing this number at all. The default matches the plan this runs
 * on today, so an unset variable is merely un-tuned rather than unlimited.
 */
function monthlyCredits(): number {
  const configured = Number(process.env['RPC_MONTHLY_CREDITS']);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000_000;
}

/**
 * The share of the allowance background work may spend.
 *
 * The rest is headroom: people trading and looking at charts, and the slack
 * that keeps a busy afternoon from eating into a month. Sweeps are the thing
 * that can always be done more slowly, so they are the thing that gives way.
 */
function backgroundShare(): number {
  const configured = Number(process.env['RPC_BACKGROUND_SHARE']);
  return Number.isFinite(configured) && configured > 0 && configured < 1 ? configured : 0.6;
}

const DAYS = 30;
const SECONDS_PER_DAY = 86_400;

/** Milliseconds a single background credit is worth, at the sustainable rate. */
function baseFloorMs(): number {
  const perSecond = (monthlyCredits() / (DAYS * SECONDS_PER_DAY)) * backgroundShare();
  return Math.max(1, Math.round(1_000 / perSecond));
}

/**
 * What each call costs, in credits.
 *
 * An estimate, and labelled as one. The provider publishes the real table and
 * it is the authority; what matters here is the shape rather than the decimals,
 * because being wrong about whether a history walk costs one credit or ten is
 * the difference between fitting inside a plan and emptying it in a week.
 *
 * Anything not listed is treated as a plain read.
 */
const CREDIT_COST: Record<string, number> = {
  // Scans every account a program owns. By far the most expensive thing this
  // app asks for, and the pool search does it.
  getProgramAccounts: 20,
  // Walk a wallet's or a token's history. The trader board is built out of
  // thousands of these.
  getSignaturesForAddress: 10,
  getTransaction: 10,
  getBlock: 10,
};

export function creditsFor(method: string): number {
  return CREDIT_COST[method] ?? 1;
}

/** As slow as background work is ever made to go, per credit. */
const MAX_FLOOR_MS = 10_000;

/** Consecutive successes before the floor is allowed to narrow again. */
const RECOVER_AFTER = 40;

/** How much of the widened floor is given back at a time. Slow, on purpose. */
const RECOVER_FACTOR = 0.8;

/** The longest a refusal may pause background work, whatever the server says. */
const MAX_COOLDOWN_MS = 60_000;

export interface GovernorStats {
  /** The sustainable gap per credit, from the plan. */
  readonly baseMs: number;
  /** What it is actually using, which is wider whenever the endpoint pushes back. */
  readonly floorMs: number;
  readonly cooling: boolean;
  readonly refusals: number;
  readonly admitted: number;
  /** Credits this process has spent on background work since it started. */
  readonly credits: number;
  /** Milliseconds background callers have spent waiting here, in total. */
  readonly waitedMs: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RpcGovernor {
  readonly #baseMs: number;
  #floorMs: number;
  #nextSlotAt = 0;
  #cooldownUntil = 0;
  #consecutiveRefusals = 0;
  #consecutiveSuccesses = 0;
  #refusals = 0;
  #admitted = 0;
  #credits = 0;
  #waitedMs = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now, base = baseFloorMs()) {
    this.#now = now;
    this.#baseMs = base;
    this.#floorMs = base;
  }

  /**
   * Hold a background caller until the budget can afford it.
   *
   * The slot is claimed before the sleep, so a burst of callers arriving
   * together take one slot each and spread out, rather than all waking to find
   * the same gap and firing into it at once. A call that costs ten credits
   * reserves ten gaps, which is what makes an expensive method expensive here
   * rather than merely expensive on the bill.
   *
   * The cooldown is waited out in a loop rather than once, because a refusal
   * arriving while somebody is already waiting extends it, and a single sleep
   * would let that caller through into the wall everybody else just backed away
   * from.
   */
  async admit(method = '', sleep: (ms: number) => Promise<void> = defaultSleep): Promise<void> {
    for (;;) {
      const waiting = this.#cooldownUntil - this.#now();
      if (waiting <= 0) break;
      this.#waitedMs += waiting;
      await sleep(waiting);
    }

    const credits = creditsFor(method);
    const now = this.#now();
    const readyAt = Math.max(now, this.#nextSlotAt);
    this.#nextSlotAt = readyAt + this.#floorMs * credits;
    this.#admitted += 1;
    this.#credits += credits;

    if (readyAt > now) {
      this.#waitedMs += readyAt - now;
      await sleep(readyAt - now);
    }
  }

  /**
   * The endpoint refused somebody. Everybody backs off.
   *
   * Multiplicative retreat, because a refusal is evidence the current rate is
   * wrong by an unknown factor, and stepping down by a fixed amount takes as
   * many refusals as the factor is large.
   *
   * `retryAfter` is the server saying exactly how long to wait, and guessing
   * shorter than it only makes things worse for everyone.
   */
  refused(retryAfterMs?: number): void {
    this.#refusals += 1;
    this.#consecutiveRefusals += 1;
    this.#consecutiveSuccesses = 0;
    this.#floorMs = Math.min(this.#floorMs * 2, MAX_FLOOR_MS);

    const backoff = Math.min(1_000 * 2 ** (this.#consecutiveRefusals - 1), MAX_COOLDOWN_MS);
    const pause = Math.min(retryAfterMs ?? backoff, MAX_COOLDOWN_MS);
    this.#cooldownUntil = Math.max(this.#cooldownUntil, this.#now() + pause);
  }

  /**
   * A request came back.
   *
   * One success proves very little, so the floor only narrows after a long run
   * of them, and never below what the plan affords. Fast to retreat and slow to
   * advance is the only arrangement that settles: the other way round
   * oscillates between hammering and sulking.
   */
  served(): void {
    this.#consecutiveRefusals = 0;
    this.#consecutiveSuccesses += 1;
    if (this.#consecutiveSuccesses < RECOVER_AFTER) return;

    this.#consecutiveSuccesses = 0;
    this.#floorMs = Math.max(this.#baseMs, Math.floor(this.#floorMs * RECOVER_FACTOR));
  }

  stats(): GovernorStats {
    return {
      baseMs: this.#baseMs,
      floorMs: this.#floorMs,
      cooling: this.#cooldownUntil > this.#now(),
      refusals: this.#refusals,
      admitted: this.#admitted,
      credits: this.#credits,
      waitedMs: this.#waitedMs,
    };
  }
}

/*
 * One governor per endpoint, for the life of the process.
 *
 * Module state rather than something passed around, because the whole point is
 * that a worker constructed in one file shares a budget with a worker
 * constructed in another that knows nothing about it. Keyed on the endpoint so
 * a fallback, or a future second provider, does not inherit the main one's
 * opinion of how fast it may go, or its bill.
 *
 * Hung off a global symbol rather than left as a plain module variable, and
 * that is not decoration. A bundler compiles this module once per bundle that
 * imports it, so the chart warmer, the curve watcher and the health route can
 * each end up holding a private copy of what was meant to be one shared budget.
 *
 * It showed exactly as it would: the health endpoint reported an empty budget
 * and nothing spent, while the provider's own meter showed thousands of credits
 * an hour going out. Every worker was being governed and none of them were
 * being governed together, which is the same failure this module was written to
 * fix, one level down.
 *
 * The same trick app/lib/watched.ts already uses, for the same reason.
 */
const GOVERNORS_KEY = Symbol.for('probatio.rpc-governors');

function registry(): Map<string, RpcGovernor> {
  const global = globalThis as typeof globalThis & {
    [GOVERNORS_KEY]?: Map<string, RpcGovernor>;
  };
  global[GOVERNORS_KEY] ??= new Map<string, RpcGovernor>();
  return global[GOVERNORS_KEY];
}

export function governorFor(endpoint: string): RpcGovernor {
  const governors = registry();
  let governor = governors.get(endpoint);
  if (!governor) {
    governor = new RpcGovernor();
    governors.set(endpoint, governor);
  }
  return governor;
}

/** What every endpoint is currently allowing, for the health endpoint. */
export function governorStats(): Record<string, GovernorStats> {
  const stats: Record<string, GovernorStats> = {};
  for (const [endpoint, governor] of registry()) {
    // Keyed by host, never by URL: the endpoint carries the API key.
    let host = 'rpc';
    try {
      host = new URL(endpoint).host;
    } catch {
      /* Not a URL. The default label is better than leaking whatever it is. */
    }
    stats[host] = governor.stats();
  }
  return stats;
}

/** Used by tests, which must not inherit another test's learned floor. */
export function resetGovernors(): void {
  registry().clear();
}
