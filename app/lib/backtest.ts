import 'server-only';
import { tokenTimeline } from '@probatio/db';
import { PUMPFUN_TOKEN_DECIMALS } from '@probatio/pools';
import { backtestRule, type BacktestResult, type ReplayPoint, type Rule } from '@probatio/sim';
import { db } from './db';
import { resolveMint } from './rpc';

/**
 * Running a rule against a token this site has actually watched.
 *
 * The engine is pure and knows nothing about where its points come from. This
 * is the part that finds them, and the only interesting decisions here are
 * about what to refuse.
 *
 * A backtest over four points is not a backtest, it is a coincidence with a
 * percentage next to it. A backtest over a window that ends an hour after it
 * starts says nothing about a rule with a six hour timeout. Both come back as a
 * stated reason rather than as a number, because a number is what somebody
 * screenshots and a reason is what stops them.
 */

/**
 * The fewest points worth answering over.
 *
 * Forty. Below that a take profit either fires on the one swap that happened to
 * cross it or never fires at all, and which of those you get is luck rather
 * than a property of the rule.
 */
const ENOUGH_POINTS = 40;

/** As far back as a replay will read. Beyond this the walk is the cost. */
const MAX_POINTS = 5_000;

export type BacktestRefusal =
  | { readonly reason: 'unwatched'; readonly detail: string }
  | { readonly reason: 'too_thin'; readonly detail: string; readonly points: number };

export interface BacktestReport {
  readonly mint: string;
  readonly result: BacktestResult;
  /** The window the points actually covered, in unix seconds. */
  readonly from: number;
  readonly to: number;
  readonly points: number;
  /**
   * True when the window ends because the record does, not because the token
   * stopped trading.
   *
   * A rule that never triggered inside a window that simply ran out is a rule
   * with no verdict, and saying so is the difference between "it did not work"
   * and "we do not know yet".
   */
  readonly windowRanOut: boolean;
  /**
   * True when the read stopped before the token did.
   *
   * A window that ends because there are more swaps than a replay will read is
   * not a window that ends because the token went quiet, and a rule reported as
   * never having triggered inside the first is a rule with no verdict rather
   * than one that failed.
   */
  readonly truncated: boolean;
  /**
   * The middle gap between the swaps the rule was checked at, in seconds.
   *
   * Kept, but no longer the number anything is judged by, because on real data
   * it says the opposite of what it was added for. See `worstGapSeconds`.
   */
  readonly medianGapSeconds: number;
  /**
   * The largest gap between two swaps the rule was checked at, in seconds.
   *
   * Measured across the position rather than across the record, because the
   * record is not what was tested. Fartcoin's densest stretches sit after a
   * fifty percent stop had already closed the position, and gaps that happened
   * when nothing was open cannot say anything about how finely the rule was
   * checked.
   *
   * The honest measure of how sparse a record is, and the correction to the
   * median above.
   *
   * The median was chosen so that a burst of swaps in one minute followed by a
   * quiet afternoon would not read as steady coverage. It achieves exactly the
   * reverse. Walked points arrive in bursts, so most gaps are the inside of a
   * burst and the median lands there: Fartcoin, 311 points over 53 days, one
   * every four hours on average, reported a median gap of eighteen seconds. The
   * panel would have said "about 18s apart" directly above a fifty percent stop
   * that filled at ninety-six.
   *
   * A high gap cannot be produced by dense coverage, which is the property the
   * median lacks.
   */
  readonly worstGapSeconds: number;
  /**
   * The gap the rule actually jumped across when it exited, in seconds.
   *
   * The single number that explains the overshoot, because it is the one hole
   * that mattered: the rule was checked, the level was not crossed, and the
   * next time anybody looked this much later it was already far past it.
   *
   * Null when there was no exit, or when the exit was the first point.
   */
  readonly exitGapSeconds: number | null;
  /**
   * How far past its own level the exit actually landed, in basis points.
   *
   * Zero would mean a rule that fired exactly where it was set. Anything larger
   * is the cost of only being able to look at recorded moments: a fifty percent
   * stop whose first recorded point past the level was already at ninety-six is
   * not a fifty percent stop, and reporting the ninety-six without this reads as
   * though it were.
   *
   * Null when no level was crossed, which covers a timeout, a window that ran
   * out, and a run that never entered.
   */
  readonly overshootBps: number | null;
  /**
   * How many recorded swaps the rule was actually checked at.
   *
   * Not `points`, and the difference is usually enormous. A position that opens
   * at the first swap and stops out at the second was tested against two swaps,
   * whatever the size of the record it was drawn from: Fartcoin holds 311 points
   * over 53 days and a fifty percent stop ends the run three days in, leaving 50
   * days and 309 points that had no bearing on the answer.
   *
   * The engine says as much about its own `steps` field, "how many points the
   * window held, not how many the rule acted on", and the panel then made
   * precisely that claim in words. A reader who sees three hundred swaps and
   * fifty days reads the figure as the verdict of a long test rather than of one
   * gap between two moments.
   */
  readonly checkedPoints: number;
}

/** How the points are spread, which is what says how fine an answer can be. */
function spacing(points: readonly ReplayPoint[]): { median: number; worst: number } {
  if (points.length < 2) return { median: 0, worst: 0 };
  const gaps: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    gaps.push(points[index]!.at - points[index - 1]!.at);
  }
  const worst = Math.max(...gaps);
  gaps.sort((left, right) => left - right);
  const middle = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 0
      ? Math.round(((gaps[middle - 1] ?? 0) + (gaps[middle] ?? 0)) / 2)
      : (gaps[middle] ?? 0);
  return { median, worst };
}

/**
 * The hole the rule jumped when it got out.
 *
 * Measured against the last point strictly before the exit rather than against
 * the one at the previous index, because several swaps can share a block time
 * and an index step would report a gap of zero for a rule that in fact had not
 * been checked for a day.
 */
function exitGap(points: readonly ReplayPoint[], exitAt: number): number | null {
  let previous: number | null = null;
  for (const point of points) {
    if (point.at >= exitAt) break;
    previous = point.at;
  }
  return previous === null ? null : exitAt - previous;
}

export async function runBacktest(
  mint: string,
  rule: Rule,
): Promise<BacktestReport | BacktestRefusal> {
  const client = await db();
  const { swaps, truncated } = await tokenTimeline(client, mint, MAX_POINTS);

  if (swaps.length === 0) {
    return {
      reason: 'unwatched',
      detail:
        'Nothing has been recorded for this token yet. A replay needs the pool as real orders ' +
        'left it, and that only exists for tokens this site has walked.',
    };
  }

  if (swaps.length < ENOUGH_POINTS) {
    return {
      reason: 'too_thin',
      points: swaps.length,
      detail:
        `Only ${swaps.length} recorded swaps. Below ${ENOUGH_POINTS} a rule either fires on the ` +
        'one swap that happened to cross it or never fires at all, and which of those you get is ' +
        'luck rather than anything about the rule.',
    };
  }

  const points: ReplayPoint[] = swaps.map((swap) => ({
    mint: swap.mint,
    at: swap.blockTime,
    solAfter: BigInt(swap.solAfter),
    tokenAfter: BigInt(swap.tokenAfter),
  }));

  /*
   * The fee schedule is read from the token's own venue, not assumed.
   *
   * A curve and a graduated pool charge differently, and the difference is
   * larger than most of the returns a backtest reports. Falling back to the
   * curve's schedule when the pool cannot be read means quoting somebody worse
   * than the market rather than better, which is the direction to be wrong in.
   */
  let fees = undefined;
  let tokenDecimals = PUMPFUN_TOKEN_DECIMALS;
  try {
    const resolution = await resolveMint(mint);
    if (resolution.pool) {
      fees = resolution.pool.fees;
      tokenDecimals = resolution.pool.tokenDecimals || PUMPFUN_TOKEN_DECIMALS;
    }
  } catch {
    /* Unreadable venue. The default below is the pessimistic one. */
  }

  const result = backtestRule(points, rule, {
    fees: fees ?? { protocolBps: 95, creatorBps: 30, lpBps: 0 },
    tokenDecimals,
  });

  const from = points[0]!.at;
  const to = points[points.length - 1]!.at;

  /*
   * The stretch of the record the position was actually open across.
   *
   * Everything about how finely the rule was checked is measured over this and
   * not over the whole timeline. A run that ends three days into a fifty day
   * record was never tested against the other forty-seven, and describing it
   * with the record's figures credits it with coverage it did not have.
   *
   * A run that never entered has no stretch, so it falls back to the record and
   * reports what was available to enter against.
   */
  const openedAt = result.entry?.at ?? from;
  const closedAt = result.exit?.at ?? to;
  const checked = points.filter((point) => point.at >= openedAt && point.at <= closedAt);
  const spread = spacing(checked);

  /*
   * How far past its level the rule actually got out.
   *
   * A stop fires on the first recorded point below the level, and on a record
   * this sparse that point can be a long way below it. Measured against the
   * level rather than against zero, so the figure is the cost of the sampling
   * rather than the size of the loss.
   */
  const level =
    result.reason === 'stop_loss' && rule.stopLossBps !== undefined
      ? -rule.stopLossBps
      : result.reason === 'take_profit' && rule.takeProfitBps !== undefined
        ? rule.takeProfitBps
        : null;
  const overshootBps =
    level === null || result.returnBps === null ? null : Math.abs(result.returnBps - level);

  return {
    mint,
    result,
    from,
    to,
    points: points.length,
    truncated,
    medianGapSeconds: spread.median,
    worstGapSeconds: spread.worst,
    checkedPoints: checked.length,
    exitGapSeconds: result.exit === null ? null : exitGap(points, result.exit.at),
    overshootBps,
    /*
     * Whether the window ran out under the rule's feet.
     *
     * A timeout longer than the window can never fire, and a position still
     * open at the end of a window that merely stopped being recorded is not the
     * same as a position that survived the token. Both are the difference
     * between "it did not work" and "we do not know yet".
     */
    windowRanOut:
      result.reason === 'still_open' ||
      result.reason === 'illiquid' ||
      (rule.timeoutSeconds !== undefined && result.entry !== null
        ? rule.timeoutSeconds > to - result.entry.at
        : false),
  };
}
