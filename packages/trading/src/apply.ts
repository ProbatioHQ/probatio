import { mulDivFloor, type Amount, type Quote } from '@probatio/sim';

/**
 * Applying a fill to a balance and a position.
 *
 * Every number here is an integer in base units, and every division rounds in
 * a stated direction. This is where a rounding error becomes free money, so
 * nothing is left to a default.
 */

export class TradingError extends Error {
  constructor(
    message: string,
    readonly code: TradingErrorCode,
  ) {
    super(message);
    this.name = 'TradingError';
  }
}

export type TradingErrorCode = 'insufficient_sol' | 'insufficient_tokens' | 'invalid_state';

export interface Position {
  readonly mint: string;
  /** Tokens held, in base units. */
  readonly tokenAmount: Amount;
  /** Total SOL paid for the tokens still held, including fees. */
  readonly costBasis: Amount;
  /** Signed. Realized profit and loss in lamports, over the position's life. */
  readonly realizedPnl: bigint;
}

export interface AccountState {
  readonly solBalance: Amount;
  readonly position: Position | null;
}

export interface FillApplication {
  readonly account: AccountState;
  /** What this particular fill realized. Zero on a buy. */
  readonly realized: bigint;
  /** True when a sell closed the position entirely. */
  readonly closed: boolean;
}

export function emptyPosition(mint: string): Position {
  return { mint, tokenAmount: 0n, costBasis: 0n, realizedPnl: 0n };
}

/**
 * Apply a filled quote.
 *
 * Buying spends the whole quoted SOL, fee included, because that is what left
 * the trader's balance. The cost basis therefore carries the fee too — a
 * position is only in profit once it has covered what it cost to open, and
 * excluding fees would report a win on a trade that lost money.
 *
 * Selling realizes a proportional slice of the basis rather than the whole of
 * it. Selling half a position must not book the entire cost against that half,
 * or every partial exit would look like a disaster and every remainder like a
 * windfall.
 */
export function applyFill(state: AccountState, quote: Quote, mint: string): FillApplication {
  return quote.side === 'buy' ? applyBuy(state, quote, mint) : applySell(state, quote, mint);
}

function applyBuy(state: AccountState, quote: Quote, mint: string): FillApplication {
  if (quote.solAmount > state.solBalance) {
    throw new TradingError(
      `this buy costs ${quote.solAmount} but the balance is ${state.solBalance}`,
      'insufficient_sol',
    );
  }

  const existing = state.position ?? emptyPosition(mint);
  if (existing.mint !== mint) {
    throw new TradingError('the position is for a different token', 'invalid_state');
  }

  return {
    account: {
      solBalance: state.solBalance - quote.solAmount,
      position: {
        mint,
        tokenAmount: existing.tokenAmount + quote.tokenAmount,
        costBasis: existing.costBasis + quote.solAmount,
        realizedPnl: existing.realizedPnl,
      },
    },
    realized: 0n,
    closed: false,
  };
}

function applySell(state: AccountState, quote: Quote, mint: string): FillApplication {
  const existing = state.position;
  if (!existing || existing.mint !== mint) {
    throw new TradingError('there is no position in this token to sell', 'insufficient_tokens');
  }
  if (quote.tokenAmount > existing.tokenAmount) {
    throw new TradingError(
      `this sell is ${quote.tokenAmount} tokens but only ${existing.tokenAmount} are held`,
      'insufficient_tokens',
    );
  }

  const closingAll = quote.tokenAmount === existing.tokenAmount;

  // The slice of the basis being disposed of. Floored, so the remaining
  // position keeps any rounding dust as cost rather than booking it as profit.
  // On a full exit the whole basis goes, which also stops a lifetime of
  // floored slices leaving a phantom cost behind on a position of zero tokens.
  const costOfSold = closingAll
    ? existing.costBasis
    : mulDivFloor(existing.costBasis, quote.tokenAmount, existing.tokenAmount);

  const realized = quote.solAmount - costOfSold;

  return {
    account: {
      solBalance: state.solBalance + quote.solAmount,
      position: {
        mint,
        tokenAmount: existing.tokenAmount - quote.tokenAmount,
        costBasis: existing.costBasis - costOfSold,
        realizedPnl: existing.realizedPnl + realized,
      },
    },
    realized,
    closed: closingAll,
  };
}

/**
 * What a position is worth at a given price, and what that means unrealized.
 *
 * The price is the scaled integer the rest of the system uses, so this stays
 * in integer arithmetic rather than converting to a double to multiply.
 */
export function unrealizedPnl(
  position: Position,
  scaledPrice: bigint,
  priceScale: bigint,
): { value: Amount; unrealized: bigint } {
  const value = mulDivFloor(position.tokenAmount, scaledPrice, priceScale);
  return { value, unrealized: value - position.costBasis };
}

/** The most tokens a trader could sell, given what they hold. */
export function sellableTokens(position: Position | null, mint: string): Amount {
  return position && position.mint === mint ? position.tokenAmount : 0n;
}

/** A fraction of a position, floored so it can never exceed the holding. */
export function fractionOfPosition(position: Position, numerator: number, denominator: number): Amount {
  if (denominator <= 0 || numerator < 0 || numerator > denominator) {
    throw new TradingError('that is not a valid fraction of a position', 'invalid_state');
  }
  if (numerator === denominator) return position.tokenAmount;
  return mulDivFloor(position.tokenAmount, BigInt(numerator), BigInt(denominator));
}
