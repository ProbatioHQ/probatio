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
}

export interface SizeRules {
  readonly stakeLamports: bigint;
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

  return OK;
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
    maxOpenPositions: integer(
      sizeSource['maxOpenPositions'], 'the number of open positions', 1, MAX_OPEN_POSITIONS,
    ),
  };

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
