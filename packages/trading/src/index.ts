/**
 * @probatio/trading — applying fills to balances and positions.
 *
 * Pure integer arithmetic, isolated from everything that touches a network or
 * a database, because this is where a rounding error turns into free money.
 */

export {
  TradingError,
  applyFill,
  emptyPosition,
  fractionOfPosition,
  sellableTokens,
  unrealizedPnl,
} from './apply';
export type {
  AccountState,
  FillApplication,
  Position,
  TradingErrorCode,
} from './apply';

export { accountEquity, valuePosition } from './equity';
export type { Equity, ValuedPosition } from './equity';
