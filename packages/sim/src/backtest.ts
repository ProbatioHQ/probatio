import { QuoteError, quoteBuy, quoteSell } from './engine';
import { DEFAULT_RULES } from './execution';
import type { FeeSchedule, PoolState } from './types';

/**
 * What an exit rule would actually have done.
 *
 * Everybody has a rule. Take profit at two hundred percent, cut at fifty, out
 * after ten minutes whatever happens. Whether it works is the one question a
 * paper trader is for, and it is normally answered against a chart, which is
 * where the answer stops being true.
 *
 * A chart is a mid price. It is what the pool would trade an infinitely small
 * amount at, and it is not available to anybody. What is available is what your
 * own sell fetches out of the reserves that exist at that moment, after your
 * order has moved them and after the fee. On a token thin enough to double in a
 * minute, those two numbers are nowhere near each other, and the gap runs
 * against you at exactly the moment the rule fires: a take profit triggers when
 * a position is large relative to the pool, which is when the exit costs most.
 *
 * So nothing here is marked at mid. The rule is checked against a real quoted
 * exit at every step, which means a rule can be reported as never having
 * triggered even though the chart went through the level. That is not a bug in
 * the backtest, it is the thing the backtest is for.
 *
 * The reserves come from swaps that really happened, and the same two functions
 * that quote every live fill on the site do the pricing here. A backtest priced
 * by anything softer would flatter itself.
 *
 * THE ONE THING IT CANNOT KNOW
 *
 * A replay is history, and history did not have you in it. Your entry is
 * charged its own impact, but the swaps that follow are the ones that really
 * happened, and they happened to a pool your order never touched. So the price
 * path after an entry is the path without you: the reserves you are quoted
 * against later are slightly deeper than they would have been, and the larger
 * the stake the further that drifts.
 *
 * It cannot be fixed by adjusting the later points, because doing so assumes
 * every other trader would have behaved identically into a pool that had moved,
 * and that assumption is worth less than the error it corrects.
 *
 * It is stated instead. It is the one direction this module is optimistic in,
 * it grows with size, and it is the reason a backtest of a stake worth a large
 * share of the pool should be read as an upper bound rather than as a result.
 *
 * AND THE OTHER THING, WHICH IS THE CALLER'S
 *
 * A rule is checked at the points it is given and nowhere else. Between two
 * points the price is not unknown so much as unasked, so a stop set at fifty
 * percent fires at whatever the next point happens to be, which on a sparse
 * record can be very much worse than fifty percent.
 *
 * That is not a fault here, and it cannot be fixed here: this walks what it is
 * handed. It does mean the answer is only as fine as the record behind it, so
 * whatever supplies the points owes the reader some idea of how far apart they
 * are and how far past its level a rule actually landed. Without that, a figure
 * produced by a four hour gap reads exactly like one produced by a four second
 * gap.
 */

/** One real swap, and the pool it left behind. */
export interface ReplayPoint {
  readonly mint: string;
  /** Unix seconds. The clock the rule's timeout runs on. */
  readonly at: number;
  /** Reserves immediately after this swap: what the next arrival would meet. */
  readonly solAfter: bigint;
  readonly tokenAfter: bigint;
}

export interface Rule {
  /** Lamports committed to the entry. */
  readonly stake: bigint;
  /** Leave once a real exit would return this much more than the entry cost. */
  readonly takeProfitBps?: number;
  /** Leave once a real exit would return this much less. */
  readonly stopLossBps?: number;
  /** Leave after this long regardless, in seconds. */
  readonly timeoutSeconds?: number;
  /** Wait this long after the window opens before entering, in seconds. */
  readonly entryDelaySeconds?: number;
}

export interface BacktestOptions {
  readonly fees: FeeSchedule;
  readonly tokenDecimals?: number;
  /**
   * The most a leg may move the price, in basis points.
   *
   * The live engine refuses a fill above this, at the quote and again at the
   * fill. A backtest without the same ceiling is not backtesting this system:
   * it will happily report an entry that took ninety-nine percent of a pool at
   * three hundred thousand basis points of impact, which is a trade nobody here
   * could have placed and a number that makes the whole run meaningless.
   *
   * On an exit it means something sharper. A position too large to leave under
   * the cap is a position you are still holding, and the run says so rather
   * than pretending the door was open.
   */
  readonly maxPriceImpactBps?: number;
}

/**
 * How the run ended.
 *
 * `no_entry` is separate from `still_open` because they are opposite facts. One
 * is a position nobody ever opened; the other is a position that could not be
 * closed. Reporting the first as the second tells a reader they are holding
 * something they never bought, and `entered` being false is not much of a
 * safeguard when the reason is the field anybody reads first.
 */
export type ExitReason =
  | 'take_profit'
  | 'stop_loss'
  | 'timeout'
  | 'still_open'
  | 'illiquid'
  | 'no_entry';

export interface BacktestLeg {
  readonly at: number;
  readonly isBuy: boolean;
  readonly sol: bigint;
  readonly tokens: bigint;
  readonly feeLamports: bigint;
  readonly priceImpactBps: number;
  /** True when the venue could not take the whole size. */
  readonly partial: boolean;
}

export interface BacktestResult {
  /** False when the window never allowed an entry at all. */
  readonly entered: boolean;
  readonly reason: ExitReason;
  readonly entry: BacktestLeg | null;
  readonly exit: BacktestLeg | null;
  readonly stake: bigint;
  /**
   * Lamports back at the end, whether sold or marked at a real exit price.
   *
   * Null when no exit could be quoted at all, which is a different thing from
   * zero. A pool that collapsed to dust inside the window leaves a position
   * nobody can put a number on, and the first version put zero there and
   * reported a hundred percent loss. That is a claim about somebody's money
   * invented out of an absence, and it is precisely what the rest of this
   * module refuses to do.
   *
   * Every figure below follows the same rule: a number is reported only when a
   * real exit could price it.
   */
  readonly proceeds: bigint | null;
  readonly returnBps: number | null;
  /** Seconds between the entry and the exit. */
  readonly heldSeconds: number;
  /** Every lamport taken in fees, across both legs. */
  readonly feesPaid: bigint;
  /**
   * The worst the position was ever worth, as a real exit, against its cost.
   *
   * The number that says whether a rule was survivable rather than merely
   * profitable. A rule that ends up ahead after being seventy percent down is
   * not a rule anybody actually holds through.
   */
  readonly worstBps: number | null;
  /** The best it ever was, on the same basis. */
  readonly bestBps: number | null;
  /**
   * What the same trade would have returned priced at mid, ignoring impact and
   * fees on both legs.
   *
   * Carried so the gap can be shown rather than argued about. This is the
   * number every other backtest reports, and the difference between it and
   * `returnBps` is what this whole module exists to make visible.
   */
  readonly onChartBps: number | null;
  /** How many points the window held. Not how many the rule acted on. */
  readonly steps: number;
}

const BPS = 10_000n;

function poolAt(point: ReplayPoint, options: BacktestOptions): PoolState {
  return {
    mint: point.mint,
    solReserve: point.solAfter,
    tokenReserve: point.tokenAfter,
    // These are a real pool's own balances, so what it holds is what it can
    // deliver. The curve's virtual-reserve case does not arise.
    deliverableTokens: point.tokenAfter,
    tokenDecimals: options.tokenDecimals ?? 6,
    fees: options.fees,
    source: 'pumpswap',
    slot: 0,
  };
}

/**
 * The sell that could really be placed right now, or null.
 *
 * Null covers two different impossibilities and they are both honest. A pool
 * too thin to take the position cannot be quoted at all, and a pool that can
 * quote it only by moving the price further than the engine allows is a fill
 * this platform would refuse. Treating either as zero would invent a total
 * loss; holding the last good value would invent liquidity. Neither is a moment
 * the rule can act on, so the walk carries on to the next one.
 */
function exitQuote(
  pool: PoolState,
  tokens: bigint,
  maxImpactBps: number,
): { sol: bigint; feeLamports: bigint; priceImpactBps: number; partial: boolean } | null {
  if (tokens <= 0n) return null;
  try {
    const quote = quoteSell(pool, tokens);
    if (quote.priceImpactBps > maxImpactBps) return null;
    return {
      sol: quote.solAmount,
      feeLamports: quote.feeLamports,
      priceImpactBps: quote.priceImpactBps,
      partial: quote.partial,
    };
  } catch (error) {
    if (error instanceof QuoteError) return null;
    throw error;
  }
}

function bpsAgainst(value: bigint, cost: bigint): number {
  if (cost <= 0n) return 0;
  return Number(((value - cost) * BPS) / cost);
}

/** Lamports per token, scaled by 1e9 so it survives integer division. */
function mid(pool: PoolState): bigint {
  return pool.tokenReserve === 0n ? 0n : (pool.solReserve * 1_000_000_000n) / pool.tokenReserve;
}

/**
 * Run a rule over a token's real history.
 *
 * The points are the pool as each real swap left it, which is what makes the
 * entry meet a pool somebody else just moved and every exit check a quote
 * against the pool as it stood.
 */
export function backtestRule(
  unordered: readonly ReplayPoint[],
  rule: Rule,
  options: BacktestOptions,
): BacktestResult {
  const maxImpactBps = options.maxPriceImpactBps ?? DEFAULT_RULES.maxPriceImpactBps;

  /*
   * Sorted here rather than required of the caller.
   *
   * Out of order points do not fail, they produce a plausible wrong answer: the
   * entry lands wherever the array happens to start, the timeout measures a
   * negative interval, and the run reports a number that looks like every other
   * number this returns. A silent wrong answer is the worst outcome available
   * to something whose output becomes a claim shown to somebody.
   *
   * A stable sort, so swaps sharing a block time keep the order they arrived
   * in, which for two trades in one block is the only ordering there is.
   */
  const points = [...unordered].sort((left, right) => left.at - right.at);

  const empty: BacktestResult = {
    entered: false,
    reason: 'no_entry',
    entry: null,
    exit: null,
    stake: rule.stake,
    proceeds: null,
    returnBps: null,
    heldSeconds: 0,
    feesPaid: 0n,
    worstBps: null,
    bestBps: null,
    onChartBps: null,
    steps: points.length,
  };

  if (points.length === 0 || rule.stake <= 0n) return empty;

  const opensAt = points[0]!.at + (rule.entryDelaySeconds ?? 0);

  /*
   * The entry is the first moment on or after the delay that can be quoted.
   *
   * Not the first point in the window: a delay exists so somebody can ask what
   * waiting would have done, and a pool that cannot take the stake is not an
   * entry either.
   */
  let index = 0;
  let entry: BacktestLeg | null = null;
  let entryPool: PoolState | null = null;
  let held = 0n;

  for (; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.at < opensAt) continue;

    const pool = poolAt(point, options);
    try {
      const quote = quoteBuy(pool, rule.stake);
      if (quote.tokenAmount <= 0n) continue;
      // A fill the live engine would refuse is not an entry here either.
      if (quote.priceImpactBps > maxImpactBps) continue;
      entry = {
        at: point.at,
        isBuy: true,
        sol: quote.solAmount,
        tokens: quote.tokenAmount,
        feeLamports: quote.feeLamports,
        priceImpactBps: quote.priceImpactBps,
        partial: quote.partial,
      };
      entryPool = pool;
      held = quote.tokenAmount;
      break;
    } catch (error) {
      if (error instanceof QuoteError) continue;
      throw error;
    }
  }

  if (!entry || !entryPool) return empty;

  const cost = entry.sol;
  const takeProfit = rule.takeProfitBps ?? null;
  const stopLoss = rule.stopLossBps ?? null;
  const deadline = rule.timeoutSeconds === undefined ? null : entry.at + rule.timeoutSeconds;

  /*
   * Seeded from the entry rather than from zero.
   *
   * A position is underwater the instant it opens: two fees and the entry's own
   * impact, which on a real pool is over a hundred basis points before the
   * price has moved at all. Starting the worst at zero claims the position was
   * once at break even, which never happened, and it is exactly the kind of
   * flattering number this module exists to avoid.
   */
  const openedAt = exitQuote(entryPool, held, maxImpactBps);
  let worstBps: number | null = openedAt ? bpsAgainst(openedAt.sol, cost) : null;
  let bestBps: number | null = worstBps;
  let reason: ExitReason = 'still_open';
  let exit: BacktestLeg | null = null;
  let lastPool = entryPool;

  for (let step = index + 1; step < points.length; step += 1) {
    const point = points[step]!;
    const pool = poolAt(point, options);
    lastPool = pool;

    const available = exitQuote(pool, held, maxImpactBps);
    if (available === null) continue;

    const moved = bpsAgainst(available.sol, cost);
    if (worstBps === null || moved < worstBps) worstBps = moved;
    if (bestBps === null || moved > bestBps) bestBps = moved;

    /*
     * Order matters, and this order is the pessimistic one.
     *
     * A single swap can carry the price through a stop and a take profit at
     * once, and only one of them can be true. Checking the stop first is the
     * assumption that the move went against you before it went for you, which
     * is the assumption a backtest should make about a moment it cannot see
     * inside of.
     */
    if (stopLoss !== null && moved <= -stopLoss) reason = 'stop_loss';
    else if (takeProfit !== null && moved >= takeProfit) reason = 'take_profit';
    else if (deadline !== null && point.at >= deadline) reason = 'timeout';
    else continue;

    exit = {
      at: point.at,
      isBuy: false,
      sol: available.sol,
      tokens: held,
      feeLamports: available.feeLamports,
      priceImpactBps: available.priceImpactBps,
      partial: available.partial,
    };
    held = 0n;
    break;
  }

  /*
   * Never triggered, so it is still held, and it is marked at what selling
   * would really fetch rather than at the chart.
   *
   * The same rule as the exits: an open position reported at mid is an open
   * position reported at a price nobody can get.
   */
  const stuck = exit ? null : exitQuote(lastPool, held, maxImpactBps);
  /*
   * Null rather than zero when nothing could be quoted.
   *
   * See `proceeds` above. A position that cannot be sold is not a position
   * worth nothing, and the difference is a hundred percentage points of
   * somebody's return.
   */
  const proceeds: bigint | null = exit ? exit.sol : (stuck?.sol ?? null);
  const endAt = exit ? exit.at : (points[points.length - 1]?.at ?? entry.at);

  const entryMid = mid(entryPool);
  const endMid = mid(lastPool);

  return {
    entered: true,
    // Entered, never exited, and nothing could price it at the end.
    reason: proceeds === null ? 'illiquid' : reason,
    entry,
    exit,
    stake: rule.stake,
    proceeds,
    returnBps: proceeds === null ? null : bpsAgainst(proceeds, cost),
    heldSeconds: Math.max(0, endAt - entry.at),
    // The exit's fee counts whether it was taken or only quoted, because the
    // proceeds it is measured against are net of it either way.
    feesPaid: entry.feeLamports + (exit?.feeLamports ?? stuck?.feeLamports ?? 0n),
    worstBps,
    bestBps,
    // A pool with no reserves has no mid either, and zero would read as a
    // hundred percent move rather than as an absence.
    onChartBps:
      entryMid === 0n || endMid === 0n ? null : Number(((endMid - entryMid) * BPS) / entryMid),
    steps: points.length,
  };
}
