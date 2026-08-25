/**
 * The rules a strategy is made of.
 *
 * A strategy here is not code. It is a set of conditions the site evaluates on
 * the owner's behalf, which is the whole reason it can keep trading with their
 * laptop shut. What it buys the reader is bounded behaviour: every strategy that
 * can be expressed is one this file can validate, price and refuse, and there is
 * no expression that reaches the engine without passing through here.
 *
 * WHY THE EXIT DECISION LIVES IN THIS FILE
 *
 * The backtester and the live runner have to answer one question identically:
 * given what this position cost and what it would fetch right now, has the rule
 * fired? Two implementations of that would agree for a while and then quietly
 * stop, and the failure would look like a strategy that backtested well and
 * traded badly, which is indistinguishable from an unlucky strategy and is the
 * single most damaging bug this feature could ship with.
 *
 * So there is one implementation, `exitDecision`, and both call it. The claim
 * that a backtest and a live run apply the same rule is then true by
 * construction rather than by anybody remembering.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * Anything that reads. No prices, no pools, no clock. Conditions are evaluated
 * against a candidate somebody else assembled, so this stays testable without a
 * chain and the runner stays the only thing that knows how to look at one.
 */

export class StrategyRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategyRulesError';
  }
}

/**
 * The stored shape's version.
 *
 * A strategy saved under one shape must never be fed to a reader expecting
 * another. Bumped when the shape changes; a strategy carrying an unknown version
 * is stopped rather than guessed at.
 */
export const RULES_VERSION = 1;

/**
 * The most orders a strategy may place in a day.
 *
 * Not a safety rail so much as a bill. Every fill reads the chain twice, and a
 * strategy that enters and leaves every few seconds instead of a few times an
 * hour does not merely trade badly, it spends a month of the site's RPC
 * allowance by itself in a day. Twenty round trips a day is an active strategy;
 * two hundred orders is five times that, so this bounds the accident without
 * being anywhere near a working strategy.
 *
 * Counted across both automated sources together, because a trader running a
 * hosted strategy and their own program is still one account making requests.
 */
export const DAILY_TRADE_CAP = 200;

/** Below this a position is not worth the two fees it costs to open and close. */
export const MIN_STAKE_LAMPORTS = 10_000_000n;

/** The most a single position may commit. The whole starting balance. */
export const MAX_STAKE_LAMPORTS = 10_000_000_000n;

export const MAX_OPEN_POSITIONS = 10;

/**
 * The most of a pool's real SOL a single position may become, in basis points.
 *
 * This is the guard that makes conviction sizing safe rather than a way to lose
 * more money confidently, and it is worth being precise about why. Exits here
 * are priced out of real reserves, and a take profit fires exactly when a
 * position is large against its pool, which is the moment leaving costs the
 * most. So a feature that raises the stake when a strategy is sure would, left
 * alone, turn its best-scoring entries into its worst-filling exits.
 *
 * Capping against the account balance would not help: the balance says nothing
 * about what the market on the other side can absorb. The cap is against the
 * pool, because the pool is the thing that has to give the money back.
 *
 * Two percent, because selling a position worth 2% of a pool's real SOL moves
 * it by roughly that much on the way out, which is a cost a take profit can
 * absorb. It is deliberately far tighter than the season's price impact
 * ceiling: that ceiling exists to refuse a ruinous fill, and this exists to
 * stop a strategy walking toward one.
 */
export const DEPTH_CAP_BPS = 200;

export type Venue = 'any' | 'curve' | 'graduated';

export interface EntryRules {
  /** Seconds since launch. A floor and a ceiling on how fresh a token is. */
  readonly minAgeSeconds?: number;
  readonly maxAgeSeconds?: number;
  /** SOL depth in the pool, in lamports. The one condition that bounds impact. */
  readonly minLiquidityLamports?: bigint;
  readonly minMarketCapLamports?: bigint;
  readonly maxMarketCapLamports?: bigint;
  /** How far it has moved over `changeWindowSeconds`, in basis points. */
  readonly minChangeBps?: number;
  readonly maxChangeBps?: number;
  readonly changeWindowSeconds?: number;
  readonly venue?: Venue;

  /*
   * Who launched it, and whether it looks like anybody stood behind it.
   *
   * The conditions above describe a price. These describe the token and the
   * person who made it, which is what somebody actually screens on: nobody
   * decides what to buy from a market cap alone. Both are read from what this
   * site already indexes, so a strategy that uses them still costs nothing to
   * leave running.
   */

  /** The token's metadata names an X account. */
  readonly requireTwitter?: boolean;
  /** The token's metadata names a website. */
  readonly requireWebsite?: boolean;
  /**
   * The most tokens this creator may have launched, counting this one.
   *
   * The serial-launcher filter. One is "only ever launched this"; three allows
   * somebody with a couple of previous coins. Counted over everything this site
   * has indexed, which is not the whole chain, so it is a floor on how many
   * they have launched rather than a complete history.
   */
  readonly maxCreatorLaunches?: number;

  /**
   * The most of the supply the launcher may still be holding, in basis points.
   *
   * The one condition here that is not free. Everything above is answered from
   * what this site already indexes; this is a read of the creator's token
   * accounts, so it is only asked about tokens that have already passed every
   * other condition. See the runner: paying for it per candidate would make an
   * idle strategy expensive, which is the one thing it must never be.
   */
  readonly maxCreatorHoldingBps?: number;

  /**
   * The most of the supply that may have been taken in the launch slot.
   *
   * The bundle filter. A creator who lands the create and a set of buys in one
   * bundle is filled before anybody watching can react, so what looks like
   * instant volume is a supply that already belongs to whoever paid for it.
   *
   * Also a chain read, and also only asked of candidates that passed everything
   * free. Unlike the holding, its answer never changes, so it is read once per
   * token and remembered.
   */
  readonly maxBundleBps?: number;

  /**
   * The fewest wallets that must actually hold it.
   *
   * The most expensive condition here: there is no index of holders, so the
   * only way to know is to scan every token account for the mint. Asked last,
   * of the few candidates that passed everything else, and held only briefly —
   * unlike a launch slot, this changes every few seconds on anything worth
   * buying.
   */
  readonly minHolders?: number;

  /**
   * The most tokens that may share this one's X account.
   *
   * The honest half of "has this account promoted a pile of coins and deleted
   * the evidence". Seeing what an account posted and then removed needs an
   * archive this does not keep. Seeing that the same account is attached to
   * eleven other launches in this site's own index needs only the index, and
   * catches the same behaviour from the other side.
   *
   * Counts the token itself, so one means an account seen once. Free: it is a
   * count over rows already here.
   */
  readonly maxSocialReuse?: number;
}

export interface SizeRules {
  /** The most a single position may commit. */
  readonly stakeLamports: bigint;
  /**
   * The least, when sizing by conviction.
   *
   * Absent means every entry is the same size, which is how this worked before
   * and remains the default. Present turns `stakeLamports` into a ceiling and
   * this into a floor, with the actual position landing between them according
   * to how comfortably the token cleared the conditions.
   */
  readonly minStakeLamports?: bigint;
  readonly maxOpenPositions: number;
}

export interface ExitRules {
  readonly takeProfitBps?: number;
  readonly stopLossBps?: number;
  readonly timeoutSeconds?: number;
}

export interface StrategyRules {
  readonly entry: EntryRules;
  readonly size: SizeRules;
  readonly exit: ExitRules;
}

/**
 * A token, as much of it as a condition can be checked against.
 *
 * Assembled by the runner from what the site already computes for its own
 * pages, which is what keeps a waiting strategy free: none of these fields costs
 * a chain read. The chain is read when an order is actually placed, and not
 * before.
 */
export interface Candidate {
  readonly mint: string;
  readonly ageSeconds: number;
  /**
   * Null where the source does not know, which is not the same as zero.
   *
   * The distinction is the whole reason these are nullable. The explore board
   * reports depth and market cap in dollars, and this side has no honest rate to
   * convert them with, so it says nothing rather than saying nought. Reported as
   * zero they would sail through every ceiling — "market cap at most a hundred
   * SOL" would match every graduated token on the feed, because nought is under
   * a hundred — while failing every floor. A condition that cannot be evaluated
   * is not a condition that has been met.
   */
  readonly liquidityLamports: bigint | null;
  readonly marketCapLamports: bigint | null;
  /** Null when there is not enough history to say, which is not the same as zero. */
  readonly changeBps: number | null;
  readonly graduated: boolean;

  /**
   * Whether the token's metadata names an X account or a website.
   *
   * Null where the metadata has not been read yet, which is common in a token's
   * first seconds and is not the same as "it has none". A condition that cannot
   * be answered is not a condition that has been met.
   */
  readonly hasTwitter: boolean | null;
  readonly hasWebsite: boolean | null;
  /** How many launches this site has indexed from this creator. Null if unknown. */
  readonly creatorLaunches: number | null;
  /**
   * What share of the supply the creator still holds, in basis points.
   *
   * Null until somebody pays to find out, which is most of the time: this is
   * the only field here that costs a chain read, so it is filled in for the few
   * candidates that survive everything else rather than for the whole list.
   */
  readonly creatorHoldingBps: number | null;
  /**
   * Share of supply taken in the launch slot, in basis points.
   *
   * Null both before anybody has looked and when a look could not tell. A rule
   * treats either as unmet: nothing bought in the launch slot and nothing known
   * about the launch slot are opposite facts, and only one of them is clean.
   */
  readonly bundledBps: number | null;
  /**
   * Wallets holding a non-zero balance. Null until somebody pays to find out.
   *
   * Counted by balance rather than by account, because a wallet that sold out
   * usually leaves its token account behind. Counting accounts would report a
   * token everybody abandoned as one with hundreds of holders.
   */
  readonly holders: number | null;
  /**
   * How many tokens in this index name the same X account, this one included.
   *
   * Null where the token names no account at all, which is a different fact
   * from an account used once and is left to the socials condition to judge.
   */
  readonly socialReuse: number | null;
}

// ---------------------------------------------------------------------------
// the one exit decision
// ---------------------------------------------------------------------------

export type ExitTrigger = 'take_profit' | 'stop_loss' | 'timeout';

/**
 * Has the rule fired?
 *
 * `movedBps` must be measured against a **real quoted exit**, never against a
 * chart. That is the difference between this and every other paper trader: a
 * take profit triggers when a position is large relative to its pool, which is
 * exactly when selling it costs the most, so a rule checked at mid fires at a
 * price nobody could have got. The caller owes this function an honest number.
 *
 * The order is the pessimistic one and it is not arbitrary. A single swap can
 * carry a price through a stop and a take profit at once and only one of them
 * can be true; checking the stop first assumes the move went against you before
 * it went for you, which is the right assumption about a moment nobody can see
 * inside of.
 */
export function exitDecision(
  exit: ExitRules,
  position: { readonly movedBps: number; readonly heldSeconds: number },
): ExitTrigger | null {
  const { takeProfitBps, stopLossBps, timeoutSeconds } = exit;

  if (stopLossBps !== undefined && position.movedBps <= -stopLossBps) return 'stop_loss';
  if (takeProfitBps !== undefined && position.movedBps >= takeProfitBps) return 'take_profit';
  if (timeoutSeconds !== undefined && position.heldSeconds >= timeoutSeconds) return 'timeout';
  return null;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export type EntryVerdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

const OK: EntryVerdict = { ok: true };

function sol(lamports: bigint): string {
  return `${(Number(lamports) / 1e9).toFixed(3)} SOL`;
}

/**
 * Does this token meet the entry conditions?
 *
 * Returns why not rather than merely false. An owner watching a strategy do
 * nothing cannot otherwise tell conditions that have not been met from a runner
 * that is broken, and those are very different things to be looking at.
 */
export function matchesEntry(entry: EntryRules, candidate: Candidate): EntryVerdict {
  if (entry.venue === 'curve' && candidate.graduated) {
    return { ok: false, why: 'it has graduated, and this strategy only trades the curve' };
  }
  if (entry.venue === 'graduated' && !candidate.graduated) {
    return { ok: false, why: 'it is still on the curve, and this strategy only trades graduates' };
  }

  if (entry.minAgeSeconds !== undefined && candidate.ageSeconds < entry.minAgeSeconds) {
    return {
      ok: false,
      why: `it is ${candidate.ageSeconds}s old, and the floor is ${entry.minAgeSeconds}s`,
    };
  }
  if (entry.maxAgeSeconds !== undefined && candidate.ageSeconds > entry.maxAgeSeconds) {
    return {
      ok: false,
      why: `it is ${candidate.ageSeconds}s old, past the ${entry.maxAgeSeconds}s ceiling`,
    };
  }

  if (entry.minLiquidityLamports !== undefined) {
    if (candidate.liquidityLamports === null) {
      return { ok: false, why: 'how much this pool holds is not known here' };
    }
    if (candidate.liquidityLamports < entry.minLiquidityLamports) {
      return {
        ok: false,
        why: `it holds ${sol(candidate.liquidityLamports)}, under the ${sol(entry.minLiquidityLamports)} floor`,
      };
    }
  }

  if (entry.minMarketCapLamports !== undefined || entry.maxMarketCapLamports !== undefined) {
    if (candidate.marketCapLamports === null) {
      return { ok: false, why: 'its market cap is not known here' };
    }
    if (
      entry.minMarketCapLamports !== undefined &&
      candidate.marketCapLamports < entry.minMarketCapLamports
    ) {
      return {
        ok: false,
        why: `its market cap is ${sol(candidate.marketCapLamports)}, under the ${sol(entry.minMarketCapLamports)} floor`,
      };
    }
    if (
      entry.maxMarketCapLamports !== undefined &&
      candidate.marketCapLamports > entry.maxMarketCapLamports
    ) {
      return {
        ok: false,
        why: `its market cap is ${sol(candidate.marketCapLamports)}, over the ${sol(entry.maxMarketCapLamports)} ceiling`,
      };
    }
  }

  const wantsChange = entry.minChangeBps !== undefined || entry.maxChangeBps !== undefined;
  if (wantsChange) {
    /*
     * No history is not a move of zero.
     *
     * A token nobody has traded since it launched has no measurable change, and
     * reading that absence as "flat" would enter every dead token on the feed
     * for a strategy asking for a move above zero. An unanswerable condition is
     * not a met one.
     */
    if (candidate.changeBps === null) {
      return { ok: false, why: 'there is not enough history yet to say how far it has moved' };
    }
    if (entry.minChangeBps !== undefined && candidate.changeBps < entry.minChangeBps) {
      return {
        ok: false,
        why: `it has moved ${candidate.changeBps} bps, under the ${entry.minChangeBps} bps floor`,
      };
    }
    if (entry.maxChangeBps !== undefined && candidate.changeBps > entry.maxChangeBps) {
      return {
        ok: false,
        why: `it has moved ${candidate.changeBps} bps, over the ${entry.maxChangeBps} bps ceiling`,
      };
    }
  }

  if (entry.requireTwitter === true) {
    if (candidate.hasTwitter === null) {
      return { ok: false, why: 'its metadata has not been read yet' };
    }
    if (!candidate.hasTwitter) return { ok: false, why: 'it names no X account' };
  }

  if (entry.requireWebsite === true) {
    if (candidate.hasWebsite === null) {
      return { ok: false, why: 'its metadata has not been read yet' };
    }
    if (!candidate.hasWebsite) return { ok: false, why: 'it names no website' };
  }

  if (entry.maxCreatorLaunches !== undefined) {
    if (candidate.creatorLaunches === null) {
      return { ok: false, why: 'how many tokens its creator has launched is not known here' };
    }
    if (candidate.creatorLaunches > entry.maxCreatorLaunches) {
      return {
        ok: false,
        why: `its creator has launched ${candidate.creatorLaunches} tokens, over the ${entry.maxCreatorLaunches} allowed`,
      };
    }
  }

  if (entry.maxCreatorHoldingBps !== undefined) {
    if (candidate.creatorHoldingBps === null) {
      return { ok: false, why: 'how much its creator holds has not been read yet' };
    }
    if (candidate.creatorHoldingBps > entry.maxCreatorHoldingBps) {
      return {
        ok: false,
        why: `its creator holds ${(candidate.creatorHoldingBps / 100).toFixed(1)}% of the supply, over the ${(entry.maxCreatorHoldingBps / 100).toFixed(1)}% allowed`,
      };
    }
  }

  if (entry.maxBundleBps !== undefined) {
    if (candidate.bundledBps === null) {
      return { ok: false, why: 'what was taken in its launch slot has not been read yet' };
    }
    if (candidate.bundledBps > entry.maxBundleBps) {
      return {
        ok: false,
        why: `${(candidate.bundledBps / 100).toFixed(1)}% of the supply went in the launch slot, over the ${(entry.maxBundleBps / 100).toFixed(1)}% allowed`,
      };
    }
  }

  if (entry.maxSocialReuse !== undefined) {
    if (candidate.socialReuse === null) {
      return { ok: false, why: 'it names no X account to check' };
    }
    if (candidate.socialReuse > entry.maxSocialReuse) {
      return {
        ok: false,
        why: `its X account is on ${candidate.socialReuse} tokens here, over the ${entry.maxSocialReuse} allowed`,
      };
    }
  }

  if (entry.minHolders !== undefined) {
    if (candidate.holders === null) {
      return { ok: false, why: 'how many wallets hold it has not been read yet' };
    }
    if (candidate.holders < entry.minHolders) {
      return {
        ok: false,
        why: `${candidate.holders} wallets hold it, under the ${entry.minHolders} required`,
      };
    }
  }

  return OK;
}

/**
 * Whether a rule needs a condition that costs a chain read.
 *
 * The runner asks this so it can check everything free first and only pay for
 * the survivors. Without it, a strategy screening on the launcher's holdings
 * would read the chain for every candidate on every pass, which is the cost
 * this whole loop is arranged to avoid.
 */
/* -------------------------------------------------------------------------
 * Sizing by conviction
 * ---------------------------------------------------------------------- */

/**
 * How comfortably a candidate cleared one condition, from 0 to 1.
 *
 * Nought means it only just got through and one means it cleared by a mile.
 * Expressed as a share of the limit rather than as an absolute distance,
 * because the limits are in different units: three launches, fifty holders and
 * twenty percent bundled cannot be compared in their own terms, and averaging
 * them raw would let whichever condition happened to use the biggest numbers
 * decide the whole score.
 *
 * WHY THE DENOMINATOR IS THE MAGNITUDE
 *
 * Because a limit can be negative. "Moved at least -20%" is an ordinary rule
 * and means the token has not dumped more than a fifth. Dividing by the limit
 * itself flips the sign of the whole calculation there, and an earlier version
 * of this shortcut it by treating any limit at or below nought as automatically
 * cleared in full. That handed a perfect score to a token sitting exactly on
 * the floor, which had cleared it by nothing at all, and dragged every average
 * containing such a condition to the top of the range. Confidence sizing giving
 * maximum conviction to something nobody cleared is precisely the failure this
 * feature must not have.
 *
 * A limit of exactly nought has no magnitude to be a share of, and there is no
 * such thing as clearing "at most 0% bundled" by a mile: it is met or it is
 * not. Null, and skipped, rather than a number nobody can defend.
 */
function ceilingMargin(value: number, limit: number): number | null {
  if (limit === 0) return null;
  return Math.max(0, Math.min(1, (limit - value) / Math.abs(limit)));
}

function floorMargin(value: number, limit: number): number | null {
  if (limit === 0) return null;
  return Math.max(0, Math.min(1, (value - limit) / Math.abs(limit)));
}

export interface Sizing {
  /** What to actually buy. */
  readonly lamports: bigint;
  /**
   * How comfortably it cleared, from 0 to 1, or null when nothing was scorable.
   *
   * Null is not zero. A strategy whose only conditions are yes-or-no ones has
   * nothing to be more or less confident about, and reading that as no
   * confidence would shrink every one of its entries to the floor for a reason
   * that has nothing to do with the token.
   */
  readonly confidence: number | null;
  /** Said plainly, because it lands in the event log the owner reads. */
  readonly why: string;
}

/**
 * What to stake on a candidate that has already passed.
 *
 * Every entry condition is a gate, so before this a token that cleared all
 * seven comfortably and one that scraped past the last of them produced an
 * identical bet. This scores the margin on each condition that has a margin,
 * averages them, and lands the position between the trader's floor and their
 * ceiling accordingly.
 *
 * Only the numeric conditions score. "Names an X account" is true or false and
 * has no such thing as clearing it by a mile, so the yes-or-no conditions stay
 * pure gates and contribute nothing either way.
 *
 * WHAT STOPS THIS BEING A WAY TO LOSE MORE, CONFIDENTLY
 *
 * The result is capped against the pool's own depth, never against the balance.
 * See `DEPTH_CAP_BPS`: a take profit fires when a position is largest against
 * its pool, which is when leaving costs the most, so raising the stake on
 * conviction without that cap would make the best-scoring entries the
 * worst-filling exits.
 *
 * A pool whose depth is not known cannot be capped, and an uncapped raise is
 * exactly the thing the cap exists to prevent, so it stays at the floor. That
 * is the same rule the conditions themselves follow: something that cannot be
 * checked has not been satisfied.
 */
export function sizeFor(size: SizeRules, entry: EntryRules, candidate: Candidate): Sizing {
  const full = size.stakeLamports;
  const floor = size.minStakeLamports;

  if (floor === undefined || floor >= full) {
    return { lamports: full, confidence: null, why: 'every position is the same size' };
  }

  const margins: number[] = [];
  const push = (value: number | null | undefined, limit: number | undefined, kind: 'floor' | 'ceiling') => {
    if (limit === undefined || value === null || value === undefined) return;
    const margin = kind === 'ceiling' ? ceilingMargin(value, limit) : floorMargin(value, limit);
    if (margin !== null) margins.push(margin);
  };

  push(candidate.ageSeconds, entry.maxAgeSeconds, 'ceiling');
  push(candidate.ageSeconds, entry.minAgeSeconds, 'floor');
  if (candidate.liquidityLamports !== null && entry.minLiquidityLamports !== undefined) {
    push(Number(candidate.liquidityLamports), Number(entry.minLiquidityLamports), 'floor');
  }
  if (candidate.marketCapLamports !== null) {
    if (entry.maxMarketCapLamports !== undefined) {
      push(Number(candidate.marketCapLamports), Number(entry.maxMarketCapLamports), 'ceiling');
    }
    if (entry.minMarketCapLamports !== undefined) {
      push(Number(candidate.marketCapLamports), Number(entry.minMarketCapLamports), 'floor');
    }
  }
  push(candidate.changeBps, entry.maxChangeBps, 'ceiling');
  push(candidate.changeBps, entry.minChangeBps, 'floor');
  push(candidate.creatorLaunches, entry.maxCreatorLaunches, 'ceiling');
  push(candidate.creatorHoldingBps, entry.maxCreatorHoldingBps, 'ceiling');
  push(candidate.bundledBps, entry.maxBundleBps, 'ceiling');
  push(candidate.holders, entry.minHolders, 'floor');
  push(candidate.socialReuse, entry.maxSocialReuse, 'ceiling');

  if (margins.length === 0) {
    return {
      lamports: full,
      confidence: null,
      why: 'no condition here has a margin to score, so it is sized in full',
    };
  }

  const confidence = margins.reduce((a, b) => a + b, 0) / margins.length;
  const scaled = floor + BigInt(Math.round(Number(full - floor) * confidence));

  /*
   * The depth cap, which may only ever pull the size down toward the floor and
   * never below it. Below the floor is the trader's own decision to make, and
   * the engine's price impact ceiling is still there to refuse a bad fill.
   */
  if (candidate.liquidityLamports === null) {
    return {
      lamports: floor,
      confidence,
      why: `cleared by ${(confidence * 100).toFixed(0)}%, but this pool's depth is not known here, so it is sized at the floor`,
    };
  }

  const cap = (candidate.liquidityLamports * BigInt(DEPTH_CAP_BPS)) / 10_000n;
  const ceiling = cap > floor ? cap : floor;
  const lamports = scaled < ceiling ? scaled : ceiling;

  return {
    lamports,
    confidence,
    why:
      lamports < scaled
        ? `cleared by ${(confidence * 100).toFixed(0)}%, held to ${(Number(lamports) / 1e9).toFixed(3)} SOL by the pool's depth`
        : `cleared by ${(confidence * 100).toFixed(0)}%`,
  };
}

export function needsCreatorHolding(entry: EntryRules): boolean {
  return entry.maxCreatorHoldingBps !== undefined;
}

export function needsBundle(entry: EntryRules): boolean {
  return entry.maxBundleBps !== undefined;
}

export function needsHolders(entry: EntryRules): boolean {
  return entry.minHolders !== undefined;
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MIN_WINDOW_SECONDS = 60;
const MAX_WINDOW_SECONDS = 60 * 60;
/** A thousand percent. Past this a take profit is a wish, not a rule. */
const MAX_TAKE_PROFIT_BPS = 100_000;

function integer(value: unknown, label: string, low: number, high: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new StrategyRulesError(`${label} has to be a whole number`);
  }
  if (parsed < low || parsed > high) {
    throw new StrategyRulesError(`${label} has to be between ${low} and ${high}`);
  }
  return parsed;
}

function lamports(value: unknown, label: string, low: bigint, high: bigint): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(typeof value === 'string' || typeof value === 'number' ? value : String(value));
  } catch {
    throw new StrategyRulesError(`${label} has to be a whole number of lamports`);
  }
  if (parsed < low || parsed > high) {
    throw new StrategyRulesError(
      `${label} has to be between ${sol(low)} and ${sol(high)}`,
    );
  }
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StrategyRulesError(`${label} is missing`);
  }
  return value as Record<string, unknown>;
}

function present(source: Record<string, unknown>, key: string): boolean {
  return source[key] !== undefined && source[key] !== null && source[key] !== '';
}

/**
 * Read a set of rules, or refuse them.
 *
 * Everything that reaches the runner comes through here, including rules read
 * back out of the database: a row written by an older version of this file is
 * exactly as untrusted as a request body, and treating stored data as
 * pre-validated is how a shape change becomes a runtime error inside a loop that
 * is placing orders.
 */
export function parseStrategyRules(input: unknown): StrategyRules {
  const source = record(input, 'the strategy');
  const entrySource = record(source['entry'], 'the entry conditions');
  const sizeSource = record(source['size'], 'the position size');
  const exitSource = record(source['exit'], 'the exit conditions');

  const entry: {
    -readonly [K in keyof EntryRules]: EntryRules[K];
  } = {};

  if (present(entrySource, 'minAgeSeconds')) {
    entry.minAgeSeconds = integer(entrySource['minAgeSeconds'], 'the minimum age', 0, MAX_AGE_SECONDS);
  }
  if (present(entrySource, 'maxAgeSeconds')) {
    entry.maxAgeSeconds = integer(entrySource['maxAgeSeconds'], 'the maximum age', 0, MAX_AGE_SECONDS);
  }
  if (
    entry.minAgeSeconds !== undefined &&
    entry.maxAgeSeconds !== undefined &&
    entry.minAgeSeconds > entry.maxAgeSeconds
  ) {
    throw new StrategyRulesError('the minimum age is above the maximum, so nothing can match');
  }

  if (present(entrySource, 'minLiquidityLamports')) {
    entry.minLiquidityLamports = lamports(
      entrySource['minLiquidityLamports'], 'the liquidity floor', 0n, 100_000_000_000_000n,
    );
  }
  if (present(entrySource, 'minMarketCapLamports')) {
    entry.minMarketCapLamports = lamports(
      entrySource['minMarketCapLamports'], 'the market cap floor', 0n, 100_000_000_000_000n,
    );
  }
  if (present(entrySource, 'maxMarketCapLamports')) {
    entry.maxMarketCapLamports = lamports(
      entrySource['maxMarketCapLamports'], 'the market cap ceiling', 0n, 100_000_000_000_000n,
    );
  }
  if (
    entry.minMarketCapLamports !== undefined &&
    entry.maxMarketCapLamports !== undefined &&
    entry.minMarketCapLamports > entry.maxMarketCapLamports
  ) {
    throw new StrategyRulesError('the market cap floor is above the ceiling, so nothing can match');
  }

  if (present(entrySource, 'minChangeBps')) {
    entry.minChangeBps = integer(entrySource['minChangeBps'], 'the minimum move', -10_000, 1_000_000);
  }
  if (present(entrySource, 'maxChangeBps')) {
    entry.maxChangeBps = integer(entrySource['maxChangeBps'], 'the maximum move', -10_000, 1_000_000);
  }
  if (
    entry.minChangeBps !== undefined &&
    entry.maxChangeBps !== undefined &&
    entry.minChangeBps > entry.maxChangeBps
  ) {
    throw new StrategyRulesError('the minimum move is above the maximum, so nothing can match');
  }
  if (present(entrySource, 'changeWindowSeconds')) {
    entry.changeWindowSeconds = integer(
      entrySource['changeWindowSeconds'], 'the move window', MIN_WINDOW_SECONDS, MAX_WINDOW_SECONDS,
    );
  }
  if (
    (entry.minChangeBps !== undefined || entry.maxChangeBps !== undefined) &&
    entry.changeWindowSeconds === undefined
  ) {
    throw new StrategyRulesError('a move condition needs a window to measure it over');
  }

  if (entrySource['requireTwitter'] === true) entry.requireTwitter = true;
  if (entrySource['requireWebsite'] === true) entry.requireWebsite = true;
  if (present(entrySource, 'maxCreatorLaunches')) {
    entry.maxCreatorLaunches = integer(
      entrySource['maxCreatorLaunches'], 'the creator launch limit', 1, 1_000,
    );
  }

  if (present(entrySource, 'maxCreatorHoldingBps')) {
    entry.maxCreatorHoldingBps = integer(
      entrySource['maxCreatorHoldingBps'], 'the creator holding limit', 0, 10_000,
    );
  }

  if (present(entrySource, 'maxBundleBps')) {
    entry.maxBundleBps = integer(entrySource['maxBundleBps'], 'the bundle limit', 0, 10_000);
  }

  if (present(entrySource, 'maxSocialReuse')) {
    entry.maxSocialReuse = integer(entrySource['maxSocialReuse'], 'the account reuse limit', 1, 10_000);
  }

  if (present(entrySource, 'minHolders')) {
    entry.minHolders = integer(entrySource['minHolders'], 'the holder floor', 1, 1_000_000);
  }

  if (present(entrySource, 'venue')) {
    const venue = String(entrySource['venue']);
    if (venue !== 'any' && venue !== 'curve' && venue !== 'graduated') {
      throw new StrategyRulesError('the venue has to be any, curve or graduated');
    }
    entry.venue = venue;
  }

  const size: SizeRules = {
    stakeLamports: lamports(
      sizeSource['stakeLamports'], 'the position size', MIN_STAKE_LAMPORTS, MAX_STAKE_LAMPORTS,
    ),
    ...(sizeSource['minStakeLamports'] === undefined || sizeSource['minStakeLamports'] === null || sizeSource['minStakeLamports'] === ''
      ? {}
      : {
          minStakeLamports: lamports(
            sizeSource['minStakeLamports'],
            'the smallest position',
            MIN_STAKE_LAMPORTS,
            MAX_STAKE_LAMPORTS,
          ),
        }),
    maxOpenPositions: integer(
      sizeSource['maxOpenPositions'], 'the number of open positions', 1, MAX_OPEN_POSITIONS,
    ),
  };

  /*
   * A floor above the ceiling is not a range, and silently swapping them would
   * be deciding for somebody what they meant. Refused, with the numbers in it.
   */
  if (size.minStakeLamports !== undefined && size.minStakeLamports >= size.stakeLamports) {
    throw new StrategyRulesError(
      `the smallest position (${sol(size.minStakeLamports)}) must be under the largest (${sol(size.stakeLamports)})`,
    );
  }

  const exit: { -readonly [K in keyof ExitRules]: ExitRules[K] } = {};
  if (present(exitSource, 'takeProfitBps')) {
    exit.takeProfitBps = integer(exitSource['takeProfitBps'], 'the take profit', 1, MAX_TAKE_PROFIT_BPS);
  }
  if (present(exitSource, 'stopLossBps')) {
    exit.stopLossBps = integer(exitSource['stopLossBps'], 'the stop loss', 1, 10_000);
  }
  if (present(exitSource, 'timeoutSeconds')) {
    exit.timeoutSeconds = integer(
      exitSource['timeoutSeconds'], 'the timeout', MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS,
    );
  }

  /*
   * A strategy with no way out is not a strategy.
   *
   * Without one of these it buys and holds until the season ends, which is a
   * legitimate thing to want and not a thing anybody means to build by leaving
   * three boxes empty. Refusing is the only reading that cannot lose somebody a
   * season to a blank field.
   */
  if (
    exit.takeProfitBps === undefined &&
    exit.stopLossBps === undefined &&
    exit.timeoutSeconds === undefined
  ) {
    throw new StrategyRulesError(
      'set at least one way out: a take profit, a stop loss, or a timeout',
    );
  }

  return { entry, size, exit };
}

/** Rules as stored. bigints become digit strings, as everywhere else here. */
export function serializeStrategyRules(rules: StrategyRules): string {
  return JSON.stringify({
    entry: {
      ...rules.entry,
      ...(rules.entry.minLiquidityLamports !== undefined
        ? { minLiquidityLamports: rules.entry.minLiquidityLamports.toString() }
        : {}),
      ...(rules.entry.minMarketCapLamports !== undefined
        ? { minMarketCapLamports: rules.entry.minMarketCapLamports.toString() }
        : {}),
      ...(rules.entry.maxMarketCapLamports !== undefined
        ? { maxMarketCapLamports: rules.entry.maxMarketCapLamports.toString() }
        : {}),
    },
    size: {
      stakeLamports: rules.size.stakeLamports.toString(),
      ...(rules.size.minStakeLamports === undefined
        ? {}
        : { minStakeLamports: rules.size.minStakeLamports.toString() }),
      maxOpenPositions: rules.size.maxOpenPositions,
    },
    exit: rules.exit,
  });
}

/** Read rules back out of storage, refusing anything this version cannot run. */
export function readStoredRules(stored: string, version: number): StrategyRules {
  if (version !== RULES_VERSION) {
    throw new StrategyRulesError(
      `these rules were saved in an older format (version ${version}); open the strategy and save it again`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new StrategyRulesError('the stored rules could not be read');
  }
  return parseStrategyRules(parsed);
}
