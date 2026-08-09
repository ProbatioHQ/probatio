import { mulDivFloor, type Amount } from '@probatio/sim';

/**
 * What an account is actually worth.
 *
 * This is the figure a season is ranked on, so it is computed here in integers
 * rather than assembled from displayed numbers somewhere in the interface. A
 * leaderboard built from rounded values would be a leaderboard of rounding.
 */

const BPS = 10_000n;

export interface ValuedPosition {
  readonly mint: string;
  readonly tokenAmount: Amount;
  readonly costBasis: Amount;
  readonly realizedPnl: bigint;
  /** Current worth in lamports, at the price the position is marked to. */
  readonly value: Amount;
}

export interface Equity {
  /** Uninvested SOL. */
  readonly cash: Amount;
  /** What the open positions are worth. */
  readonly positionValue: Amount;
  /** Cash plus positions. The number a season is ranked on. */
  readonly equity: Amount;
  /** Booked profit and loss from closed and partly closed positions. */
  readonly realized: bigint;
  /** Profit and loss still riding on open positions. */
  readonly unrealized: bigint;
  /** Everything, against where the account started. */
  readonly totalPnl: bigint;
  /**
   * Return in basis points, signed.
   *
   * Truncated toward zero, so a trader is never shown a gain they have not
   * quite made.
   */
  readonly returnBps: number;
}

export function valuePosition(
  position: { tokenAmount: Amount; costBasis: Amount; realizedPnl: bigint; mint: string },
  scaledPrice: bigint,
  priceScale: bigint,
): ValuedPosition {
  return {
    mint: position.mint,
    tokenAmount: position.tokenAmount,
    costBasis: position.costBasis,
    realizedPnl: position.realizedPnl,
    value: mulDivFloor(position.tokenAmount, scaledPrice, priceScale),
  };
}

/**
 * Roll an account up.
 *
 * Realized comes from every position the account has ever held, including the
 * closed ones — a trader who made money and exited must not appear to have
 * made nothing.
 */
export function accountEquity(
  cash: Amount,
  openPositions: readonly ValuedPosition[],
  realizedFromAllPositions: bigint,
  startingBalance: Amount,
): Equity {
  const positionValue = openPositions.reduce((sum, position) => sum + position.value, 0n);
  const openCost = openPositions.reduce((sum, position) => sum + position.costBasis, 0n);

  const equity = cash + positionValue;
  const unrealized = positionValue - openCost;
  const totalPnl = equity - startingBalance;

  const magnitude = totalPnl < 0n ? -totalPnl : totalPnl;
  const bps =
    startingBalance === 0n ? 0 : Number(mulDivFloor(magnitude, BPS, startingBalance));

  return {
    cash,
    positionValue,
    equity,
    realized: realizedFromAllPositions,
    unrealized,
    totalPnl,
    returnBps: totalPnl < 0n ? -bps : bps,
  };
}
