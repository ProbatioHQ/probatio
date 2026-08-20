import 'server-only';
import { hashLeaf, toHex } from '@probatio/commit';
import {
  ConcurrentTradeError,
  isSuspended,
  openPosition,
  recordTrade,
  type AccountRow,
  type Client,
} from '@probatio/db';
import { PUMPFUN_TOKEN_DECIMALS, type Resolution } from '@probatio/pools';
import { DEFAULT_RULES, simulateFill, totalFeeBps } from '@probatio/sim';
import { applyFill, emptyPosition, TradingError, type AccountState } from '@probatio/trading';

/**
 * One fill, wherever the order came from.
 *
 * The honest fill is a sequence, not a calculation: read the pool at the click,
 * wait out the account's latency, read it again, quote against the second
 * reading, then write the result conditionally on the balance it was quoted
 * against still holding. Every step has a reason and several of them exist
 * because getting them wrong was cheap and undetectable.
 *
 * It lived inside the trade route, and the accounts that trade free play copied
 * it. Two copies of a sequence like this is already a problem: they drift, and
 * the drift shows up as a fill somebody could not have got rather than as a
 * failing test. A Telegram bot placing orders would have been the third copy,
 * which is why this is being lifted out before the bot is written rather than
 * after.
 *
 * Deliberately not a route handler. It knows nothing about HTTP, sessions or
 * chat ids: it takes an account and a market reader and returns an outcome. The
 * route turns that into a response, and the bot will turn the same outcome into
 * a card.
 */

/** How the caller reads the market. Two calls, never coalesced. See below. */
export interface MarketReader {
  /** The pool as it stands when the order is placed. */
  atClick(mint: string): Promise<Resolution>;
  /**
   * The pool after the latency wait, read fresh.
   *
   * Must not share an in-flight read with anything else. A fill that latched
   * onto a read begun before the delay would hand back exactly the pre-delay
   * execution the delay exists to deny.
   */
  atFill(mint: string): Promise<Resolution>;
}

export interface TradeRequest {
  readonly client: Client;
  readonly account: AccountRow;
  readonly seasonId: number;
  readonly userPubkey: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  /** Lamports for a buy, token base units for a sell. */
  readonly size: bigint;
  readonly slippageBps?: number;
  readonly market: MarketReader;
  /** Waits out the season's latency. Injected so a test does not sit there. */
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: number;
}

export type TradeOutcome =
  | { readonly status: 'filled'; readonly fill: Filled }
  | { readonly status: 'rejected'; readonly reason: string; readonly detail: string;
      readonly expected?: { solAmount: string; tokenAmount: string } | null }
  | { readonly status: 'suspended'; readonly detail: string }
  | { readonly status: 'degraded'; readonly detail: string }
  | { readonly status: 'unlisted'; readonly detail: string };

export interface Filled {
  readonly tradeId: number;
  readonly sequence: number;
  readonly side: 'buy' | 'sell';
  readonly mint: string;
  readonly expected: { solAmount: string; tokenAmount: string };
  readonly filled: {
    solAmount: string;
    tokenAmount: string;
    feeLamports: string;
    priceImpactBps: number;
    partial: boolean;
  };
  readonly slippageBps: number;
  readonly latencyMs: number;
  readonly balance: string;
  readonly position: { tokenAmount: string; costBasis: string; realizedPnl: string };
  readonly realized: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeTrade(request: TradeRequest): Promise<TradeOutcome> {
  const { client, account, seasonId, userPubkey, mint, side, size, market } = request;
  const now = request.now ?? Date.now();
  const wait = request.wait ?? sleep;
  const slippageBps = request.slippageBps ?? DEFAULT_RULES.slippageBps;

  /*
   * A token the monitor found farmable is off the board.
   *
   * Checked before the chain is read, because a refusal should not cost an RPC
   * round trip, and this is the one place a suspension has to bite. Free play is
   * refused too: a trade there is committed the same way and shows on the same
   * public record, so a fill the engine got wrong is worth the same to somebody
   * building a track record.
   */
  if (await isSuspended(client, mint)) {
    return {
      status: 'suspended',
      detail:
        'This token is suspended. The simulator was filling it differently from the market, ' +
        'so trading it is off until that is resolved. Nothing was charged and no position changed.',
    };
  }

  /*
   * Reading the chain is not optional.
   *
   * A fill quoted against a cached pool is a fabricated fill, so when the chain
   * cannot be read the trade is refused rather than estimated. This is the one
   * thing that never degrades.
   */
  let atClick: Resolution;
  try {
    atClick = await market.atClick(mint);
  } catch {
    return {
      status: 'degraded',
      detail:
        'Live prices cannot be read right now, so trading is off. Nothing was charged and ' +
        'no position changed.',
    };
  }
  if (!atClick.pool) {
    return {
      status: 'unlisted',
      detail: 'this token has no live market. It may have graduated with no pool.',
    };
  }

  // The wait that makes the fill honest.
  await wait(account.latencyMs);

  let atFill: Resolution;
  try {
    atFill = await market.atFill(mint);
  } catch {
    /*
     * The click was priced and the fill could not be.
     *
     * Refusing is the only honest outcome: filling at the click price would hand
     * the trader the delay-free execution the whole engine exists to deny them.
     */
    return {
      status: 'degraded',
      detail:
        'Live prices became unreadable while the trade was in flight, so it was not filled. ' +
        'Nothing changed.',
    };
  }
  if (!atFill.pool) {
    return { status: 'rejected', reason: 'no_liquidity', detail: 'the market disappeared mid-trade' };
  }

  const position = await openPosition(client, account.id, mint);
  const state: AccountState = {
    solBalance: BigInt(account.solBalance),
    position: position
      ? {
          mint: position.mint,
          tokenAmount: BigInt(position.tokenAmount),
          costBasis: BigInt(position.costBasis),
          realizedPnl: BigInt(position.realizedPnl),
        }
      : null,
  };

  // Checked before simulating, so a trader is told they cannot afford it rather
  // than watching the engine reject a size it was never going to fill.
  if (side === 'buy' && size > state.solBalance) {
    return { status: 'rejected', reason: 'insufficient_sol', detail: 'not enough SOL' };
  }
  if (side === 'sell' && size > (state.position?.tokenAmount ?? 0n)) {
    return { status: 'rejected', reason: 'insufficient_tokens', detail: 'you do not hold that many' };
  }

  const outcome = simulateFill({
    side,
    size,
    atClick: atClick.pool,
    atFill: atFill.pool,
    rules: {
      latencyMs: account.latencyMs,
      slippageBps,
      maxPriceImpactBps: account.maxPriceImpactBps,
      allowPartialFills: true,
    },
  });

  if (outcome.status === 'rejected') {
    // A rejection is a real outcome, not an error. Real transactions revert.
    return {
      status: 'rejected',
      reason: outcome.reason,
      detail: outcome.detail,
      expected: outcome.expected
        ? {
            solAmount: outcome.expected.solAmount.toString(),
            tokenAmount: outcome.expected.tokenAmount.toString(),
          }
        : null,
    };
  }

  const pool = atFill.pool;
  let applied;
  try {
    applied = applyFill(state, outcome.quote, mint);
  } catch (error) {
    if (error instanceof TradingError) {
      return { status: 'rejected', reason: error.code, detail: error.message };
    }
    throw error;
  }

  const nextPosition = applied.account.position ?? emptyPosition(mint);

  // Everything about the leaf except its sequence, which is only settled inside
  // the write transaction.
  const leafBase = {
    seasonOrdinal: account.seasonOrdinal,
    trader: userPubkey,
    mint,
    side,
    solAmount: outcome.quote.solAmount,
    tokenAmount: outcome.quote.tokenAmount,
    feeLamports: outcome.quote.feeLamports,
    solReserve: pool.solReserve,
    tokenReserve: pool.tokenReserve,
    deliverableTokens: pool.deliverableTokens,
    feeBps: totalFeeBps(pool.fees),
    poolSource: pool.source,
    priceImpactBps: outcome.quote.priceImpactBps,
    partial: outcome.quote.partial,
    clickedAtSlot: atClick.slot,
    filledAtSlot: pool.slot,
    latencyMs: account.latencyMs,
    engineVersion: outcome.quote.engineVersion,
    createdAt: now,
  };

  let recorded;
  try {
    recorded = await recordTrade(client, {
      snapshot: {
        mint,
        solReserve: pool.solReserve.toString(),
        tokenReserve: pool.tokenReserve.toString(),
        // The buy cap the leaf commits to. Stored, not derived from the reserve,
        // because on a curve it is the real reserve and differs from the virtual
        // one the price uses.
        deliverableTokens: pool.deliverableTokens.toString(),
        tokenDecimals: pool.tokenDecimals || PUMPFUN_TOKEN_DECIMALS,
        feeBps: totalFeeBps(pool.fees),
        source: pool.source,
        slot: pool.slot,
      },
      trade: {
        accountId: account.id,
        seasonId,
        userPubkey,
        mint,
        side,
        solAmount: outcome.quote.solAmount.toString(),
        tokenAmount: outcome.quote.tokenAmount.toString(),
        fee: outcome.quote.feeLamports.toString(),
        priceImpactBps: outcome.quote.priceImpactBps,
        partial: outcome.quote.partial,
        poolSource: pool.source,
        clickedAtSlot: atClick.slot,
        filledAtSlot: pool.slot,
        latencyMs: account.latencyMs,
        engineVersion: outcome.quote.engineVersion,
      },
      position: {
        accountId: account.id,
        mint,
        tokenAmount: nextPosition.tokenAmount.toString(),
        costBasis: nextPosition.costBasis.toString(),
        realizedPnl: nextPosition.realizedPnl.toString(),
        closed: applied.closed,
      },
      // The state this fill was quoted against, read before the latency wait.
      // The write is conditional on it still holding.
      expected: {
        solBalance: account.solBalance,
        tokenAmount: position?.tokenAmount ?? null,
      },
      newBalance: applied.account.solBalance.toString(),
      leafHashFor: (sequence) => toHex(hashLeaf({ ...leafBase, sequence })),
      now,
    });
  } catch (error) {
    /*
     * Another trade on this account landed while this one was in flight.
     *
     * The gap is not theoretical: the engine deliberately waits out the season's
     * latency between quoting and writing, so two orders a fraction of a second
     * apart are both quoted against the same balance. Before the write became
     * conditional, both would commit and the trader would have spent one balance
     * twice, minting the practice SOL the leaderboard ranks on.
     *
     * Rejected rather than retried. A retry would fill at a price quoted against
     * a balance that no longer exists, which is the same lie the latency exists
     * to prevent. The trader asks again and gets a fresh quote.
     */
    if (error instanceof ConcurrentTradeError) {
      return {
        status: 'rejected',
        reason: 'raced',
        detail:
          'Another of your trades landed while this one was in flight, so this one was not ' +
          'filled. Nothing changed. Try again.',
      };
    }
    throw error;
  }

  return {
    status: 'filled',
    fill: {
      tradeId: recorded.id,
      sequence: recorded.sequence,
      side,
      mint,
      // Both figures travel with the fill so an interface can show the haircut
      // rather than quietly presenting the fill as though it were the quote.
      expected: {
        solAmount: outcome.expected.solAmount.toString(),
        tokenAmount: outcome.expected.tokenAmount.toString(),
      },
      filled: {
        solAmount: outcome.quote.solAmount.toString(),
        tokenAmount: outcome.quote.tokenAmount.toString(),
        feeLamports: outcome.quote.feeLamports.toString(),
        priceImpactBps: outcome.quote.priceImpactBps,
        partial: outcome.quote.partial,
      },
      slippageBps: outcome.slippageBps,
      latencyMs: outcome.latencyMs,
      balance: applied.account.solBalance.toString(),
      position: {
        tokenAmount: nextPosition.tokenAmount.toString(),
        costBasis: nextPosition.costBasis.toString(),
        realizedPnl: nextPosition.realizedPnl.toString(),
      },
      realized: applied.realized.toString(),
    },
  };
}
