import type { Quote } from '@probatio/sim';
import { applyFill, emptyPosition, type AccountState, type Position } from '@probatio/trading';

/**
 * Turning a trade log back into positions.
 *
 * The log is flat — buys and sells in the order they happened — but nothing a
 * trader wants to know about themselves is a fact about a single fill. Win
 * rate, hold time and exit quality are all facts about a *round trip*: the span
 * from opening a position in a token to closing it again.
 *
 * The replay runs through `applyFill`, the same function that wrote the
 * balances in the first place, rather than a second implementation of the same
 * arithmetic. Two implementations of proportional cost basis would eventually
 * disagree, and the version a trader reads on their profile disagreeing with
 * the version committed to the chain is the one bug this product cannot have.
 */

/** One fill, as the log stores it. */
export interface LoggedTrade {
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  /** Lamports. Spent on a buy, received on a sell. */
  readonly solAmount: bigint;
  /** Base units. */
  readonly tokenAmount: bigint;
  readonly feeLamports: bigint;
  readonly priceImpactBps: number;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

export interface RoundTrip {
  readonly mint: string;
  readonly openedAt: number;
  readonly closedAt: number;
  /** Milliseconds from the first buy to the closing sell. */
  readonly heldMs: number;
  /** Everything paid in, fees included. */
  readonly invested: bigint;
  /** Everything taken out. */
  readonly proceeds: bigint;
  /** Signed. `proceeds - invested`. */
  readonly realized: bigint;
  readonly feesPaid: bigint;
  readonly buys: number;
  readonly sells: number;
  /** The largest number of tokens held at any point. */
  readonly peakTokens: bigint;
  /** Total tokens acquired. Equals `tokensSold`, since the trip closed. */
  readonly tokensBought: bigint;
  readonly tokensSold: bigint;
  /** Every fill in the trip, in order. */
  readonly trades: readonly LoggedTrade[];
}

/** A position still open at the end of the log. */
export interface OpenTrip {
  readonly mint: string;
  readonly openedAt: number;
  readonly invested: bigint;
  readonly position: Position;
  readonly trades: readonly LoggedTrade[];
}

export interface Reconstruction {
  readonly closed: readonly RoundTrip[];
  readonly open: readonly OpenTrip[];
  /**
   * Fills the replay could not apply — a sell with nothing to sell, a buy in a
   * token whose position belongs to someone else. Reported rather than thrown,
   * because a single unusable row must not cost a trader every statistic they
   * have.
   */
  readonly skipped: readonly LoggedTrade[];
}

function toQuote(trade: LoggedTrade): Quote {
  return {
    side: trade.side,
    solAmount: trade.solAmount,
    tokenAmount: trade.tokenAmount,
    feeLamports: trade.feeLamports,
    priceImpactBps: trade.priceImpactBps,
    partial: false,
    // Not read by applyFill. The replay is arithmetic over recorded fills, not
    // a re-quote, so the engine that produced them does not enter into it.
    engineVersion: 0,
  };
}

interface InFlight {
  mint: string;
  openedAt: number;
  invested: bigint;
  proceeds: bigint;
  feesPaid: bigint;
  buys: number;
  sells: number;
  peakTokens: bigint;
  tokensBought: bigint;
  tokensSold: bigint;
  trades: LoggedTrade[];
  account: AccountState;
}

/**
 * Replay a trade log into round trips.
 *
 * Trades must arrive oldest first. Each token is replayed independently, since
 * a position in one says nothing about a position in another, and the balance
 * carried through the replay is a per-token device rather than the trader's
 * real one — it is set high enough that the replay never fails on funds a
 * trader demonstrably had at the time.
 */
export function reconstruct(trades: readonly LoggedTrade[]): Reconstruction {
  const byMint = new Map<string, InFlight>();
  const closed: RoundTrip[] = [];
  const skipped: LoggedTrade[] = [];

  for (const trade of trades) {
    let trip = byMint.get(trade.mint);

    if (!trip) {
      // A sell with no position behind it opens nothing. Whatever produced it,
      // there is no round trip to attribute it to.
      if (trade.side === 'sell') {
        skipped.push(trade);
        continue;
      }
      trip = {
        mint: trade.mint,
        openedAt: trade.at,
        invested: 0n,
        proceeds: 0n,
        feesPaid: 0n,
        buys: 0,
        sells: 0,
        peakTokens: 0n,
        tokensBought: 0n,
        tokensSold: 0n,
        trades: [],
        account: { solBalance: 0n, position: emptyPosition(trade.mint) },
      };
      byMint.set(trade.mint, trip);
    }

    // The replay's balance is bookkeeping, not the trader's. Topping it up
    // before a buy keeps `applyFill` from rejecting a fill that really
    // happened — the log is the record of what occurred, not a proposal.
    const state: AccountState =
      trade.side === 'buy'
        ? { ...trip.account, solBalance: trip.account.solBalance + trade.solAmount }
        : trip.account;

    let result;
    try {
      result = applyFill(state, toQuote(trade), trade.mint);
    } catch {
      skipped.push(trade);
      continue;
    }

    trip.account = result.account;
    trip.trades.push(trade);
    trip.feesPaid += trade.feeLamports;

    if (trade.side === 'buy') {
      trip.invested += trade.solAmount;
      trip.tokensBought += trade.tokenAmount;
      trip.buys += 1;
      const held = result.account.position?.tokenAmount ?? 0n;
      if (held > trip.peakTokens) trip.peakTokens = held;
    } else {
      trip.proceeds += trade.solAmount;
      trip.tokensSold += trade.tokenAmount;
      trip.sells += 1;
    }

    if (result.closed) {
      closed.push({
        mint: trip.mint,
        openedAt: trip.openedAt,
        closedAt: trade.at,
        heldMs: Math.max(0, trade.at - trip.openedAt),
        invested: trip.invested,
        proceeds: trip.proceeds,
        realized: trip.proceeds - trip.invested,
        feesPaid: trip.feesPaid,
        buys: trip.buys,
        sells: trip.sells,
        peakTokens: trip.peakTokens,
        tokensBought: trip.tokensBought,
        tokensSold: trip.tokensSold,
        trades: trip.trades,
      });
      // Buying the same token again starts a new trip rather than reopening
      // the old one. They are separate decisions and merging them would hide
      // the result of both.
      byMint.delete(trade.mint);
    }
  }

  const open: OpenTrip[] = [...byMint.values()].map((trip) => ({
    mint: trip.mint,
    openedAt: trip.openedAt,
    invested: trip.invested,
    position: trip.account.position ?? emptyPosition(trip.mint),
    trades: trip.trades,
  }));

  return { closed, open, skipped };
}
