import 'server-only';
import { lastPrices, openPositions, type AccountRow } from '@probatio/db';
import { PRICE_SCALE } from '@probatio/candles';
import { db } from '../db';
import { activeSeason } from '../season';
import { noteActivity } from '../activity';
import { executeTrade, type MarketReader, type TradeOutcome } from '../execute-trade';
import { resolveFill, resolveMint } from '../rpc';

/**
 * Trading from a chat.
 *
 * Nothing about the fill happens here. This finds out whose account a message
 * belongs to, turns "0.5" into lamports, and hands the rest to `executeTrade`,
 * which is the same sequence the website and the free-play accounts run. That
 * was the entire reason for lifting it out before this was written: a bot with
 * its own copy of the fill sequence would drift from the site, and the drift
 * would show up as a fill somebody could not have got rather than as a failing
 * test.
 *
 * So a fill placed from Telegram is honest in exactly the way one placed from
 * the site is honest. It waits out the season's latency, it is quoted against
 * the pool as it stands after that wait, and it is sealed into the same record.
 * There is no chat-flavoured shortcut.
 */

/*
 * The two reads a fill needs, and they are not the same read.
 *
 * The click may share an in-flight read with everybody else looking at this
 * token. The fill never shares: coalescing would let it latch onto a read begun
 * before this trade's delay elapsed, handing back the pre-delay execution the
 * delay exists to prevent.
 */
const MARKET: MarketReader = { atClick: resolveMint, atFill: resolveFill };

const LAMPORTS = 1_000_000_000n;

export const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A SOL amount as somebody would type it into a chat.
 *
 * Parsed as a decimal string rather than through a float. `0.1` is not
 * representable in binary, and `Number('0.1') * 1e9` is 100000000.00000001,
 * which truncates to the right answer today and would quietly stop doing so on
 * some other figure. Balances are integers here and stay integers.
 */
export function parseSol(input: string): bigint | null {
  const text = input.trim().replace(/^\+/, '');
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null;

  const [whole = '', fraction = ''] = text.split('.');
  if (fraction.length > 9) return null;

  const lamports = BigInt(whole || '0') * LAMPORTS + BigInt((fraction || '0').padEnd(9, '0'));
  return lamports > 0n ? lamports : null;
}

export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const value = negative ? -lamports : lamports;
  const whole = value / LAMPORTS;
  const fraction = (value % LAMPORTS).toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** A percentage of a holding, which is how people sell. */
export function parsePercent(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/%$/, '');
  if (text === 'all' || text === 'everything') return 100;
  if (text === 'half') return 50;
  if (!/^\d{1,3}$/.test(text)) return null;
  const percent = Number(text);
  return percent > 0 && percent <= 100 ? percent : null;
}

export interface Trader {
  readonly pubkey: string;
  readonly account: AccountRow;
  readonly seasonId: number;
  readonly ranked: boolean;
}

/** The account behind a linked wallet, created on first use like the site's. */
export async function traderFor(pubkey: string, now: number): Promise<Trader> {
  const client = await db();
  const season = await activeSeason(client, pubkey, now);
  return {
    pubkey,
    account: season.account,
    seasonId: season.seasonId,
    ranked: season.ranked,
  };
}

export interface ChatTrade {
  readonly pubkey: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  /** Lamports for a buy; a percentage of the holding for a sell. */
  readonly amount: bigint | number;
  readonly now?: number;
}

export type ChatOutcome =
  | { readonly status: 'no_position'; readonly mint: string }
  | { readonly status: 'no_balance' }
  | TradeOutcome;

export async function tradeFromChat(request: ChatTrade): Promise<ChatOutcome> {
  const now = request.now ?? Date.now();
  const client = await db();
  const trader = await traderFor(request.pubkey, now);

  let size: bigint;
  if (request.side === 'buy') {
    size = request.amount as bigint;
    if (size > BigInt(trader.account.solBalance)) return { status: 'no_balance' };
  } else {
    /*
     * A sell is a percentage of what is actually held, resolved here rather
     * than in the button.
     *
     * The alternative is putting a token amount in the callback data, which
     * goes stale the moment anything else touches the position: a card sat in
     * a chat for an hour would try to sell tokens that are no longer there.
     */
    const position = (await openPositions(client, trader.account.id)).find(
      (held) => held.mint === request.mint,
    );
    const held = position ? BigInt(position.tokenAmount) : 0n;
    if (held <= 0n) return { status: 'no_position', mint: request.mint };

    const percent = request.amount as number;
    // A hundred percent means the position, not ninety-nine point nine of it.
    // Rounding down a full exit leaves dust that can never be sold and a
    // position that never closes.
    size = percent >= 100 ? held : (held * BigInt(percent)) / 100n;
    if (size <= 0n) return { status: 'no_position', mint: request.mint };
  }

  const outcome = await executeTrade({
    client,
    account: trader.account,
    seasonId: trader.seasonId,
    userPubkey: trader.pubkey,
    mint: request.mint,
    side: request.side,
    size,
    market: MARKET,
    now,
  });

  // Recorded after the fill landed, so activity means a trade that happened
  // rather than one that was attempted. Same rule as the route.
  if (outcome.status === 'filled') await noteActivity(client, trader.pubkey, true, now);

  return outcome;
}

export interface HeldToken {
  readonly mint: string;
  readonly tokenAmount: bigint;
  readonly costBasis: bigint;
  /** Marked at the last stored price, or held at cost when there is none. */
  readonly value: bigint;
  readonly priced: boolean;
}

export interface Portfolio {
  readonly pubkey: string;
  readonly ranked: boolean;
  readonly solBalance: bigint;
  readonly startingBalance: bigint;
  readonly held: readonly HeldToken[];
  readonly equity: bigint;
  readonly realizedPnl: bigint;
}

/**
 * How long a stored price may be and still mark a position.
 *
 * Twenty minutes, the same window the boards use. Positions are priced once a
 * minute by the marker, so in practice this reads a figure under a minute old;
 * the window is there so a token nobody has touched in a day is held at cost
 * rather than marked against yesterday.
 */
const PRICE_STALE_SECONDS = 20 * 60;

/**
 * What somebody holds.
 *
 * Marked from the candles on disk rather than by reading the chain per token. A
 * chat answer that takes twelve seconds and sometimes times out is worse than
 * one that is a minute behind and always arrives, and the marker is writing
 * those candles every minute anyway.
 */
export async function portfolioFor(pubkey: string, now: number): Promise<Portfolio> {
  const client = await db();
  const trader = await traderFor(pubkey, now);
  const positions = await openPositions(client, trader.account.id);

  const prices = await lastPrices(
    client,
    positions.map((held) => held.mint),
    Math.floor(now / 1_000) - PRICE_STALE_SECONDS,
  );

  const held = positions.map((position): HeldToken => {
    const close = prices.get(position.mint);
    const tokenAmount = BigInt(position.tokenAmount);
    const costBasis = BigInt(position.costBasis);
    return {
      mint: position.mint,
      tokenAmount,
      costBasis,
      // Unreadable is not worthless. A position with no recent candle is
      // carried at what it cost, and said to be, rather than marked at zero.
      value: close === undefined ? costBasis : (tokenAmount * BigInt(close)) / PRICE_SCALE,
      priced: close !== undefined,
    };
  });

  const solBalance = BigInt(trader.account.solBalance);
  return {
    pubkey,
    ranked: trader.ranked,
    solBalance,
    startingBalance: BigInt(trader.account.startingBalance),
    held,
    equity: held.reduce((total, token) => total + token.value, solBalance),
    realizedPnl: positions.reduce((total, position) => total + BigInt(position.realizedPnl), 0n),
  };
}
