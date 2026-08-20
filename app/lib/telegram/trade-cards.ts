import 'server-only';
import type { InlineKeyboard } from './types';
import type { ChatOutcome, HeldToken, Portfolio } from './trade';
import { formatSol } from './trade';
import { b, code, html, lines, rows } from './format';
import { howLong } from './season';

/**
 * What a trade looks like in a chat.
 *
 * Two rules, and both of them are about not letting a chat message be a nicer
 * story than the record it came from.
 *
 * The fill card prints what was asked for beside what was got. Every other
 * paper trader shows the quote and calls it a fill; this engine exists because
 * that is a lie, and a card that quietly reported the good number would put the
 * lie back in at the last step.
 *
 * And a refusal is printed as plainly as a fill. Rejections are real outcomes
 * here, not errors: real transactions revert, and a simulator whose fills never
 * fail is teaching a habit that costs money later.
 *
 * Every interpolated value goes through `html`, which escapes it, so a token
 * name of somebody's choosing can never turn half a message italic or stop it
 * sending. The figure somebody is looking for is bold, and anything they might
 * paste elsewhere is monospace, which on Telegram is also tap-to-copy.
 *
 * Paragraphs are single lines. Telegram wraps to the bubble, and a paragraph
 * pre-broken at eighty characters and re-broken at forty comes out as a ragged
 * column of one-word orphans on a phone.
 */

const SITE = process.env['PROBATIO_SITE'] ?? 'https://probatiotrade.com';

export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** Whole tokens, which is the unit people say out loud. */
function tokens(baseUnits: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = baseUnits / scale;
  if (whole >= 1_000_000n) return `${whole / 1_000n}k`;
  if (whole >= 1_000n) return whole.toLocaleString('en-US');
  const fraction = (baseUnits % scale).toString().padStart(decimals, '0').slice(0, 2).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/*
 * Sixty-four bytes, and Telegram silently refuses a keyboard that exceeds it.
 *
 * A mint is forty-four of them, so everything else has to be small: a one
 * letter tag, the amount as typed, and the owner's Telegram id in base thirty
 * six. Asserted rather than trusted, because the failure mode is a card that
 * simply never appears.
 */
const CALLBACK_LIMIT = 64;

export function callbackData(
  tag: 'b' | 's' | 't',
  amount: string,
  owner: number,
  mint: string,
): string {
  const data = `${tag}:${amount}:${owner.toString(36)}:${mint}`;
  if (data.length > CALLBACK_LIMIT) throw new Error(`callback data too long: ${data.length}`);
  return data;
}

export interface ParsedAction {
  readonly tag: 'b' | 's' | 't';
  readonly amount: string;
  readonly owner: number;
  readonly mint: string;
}

export function parseAction(data: string): ParsedAction | null {
  const [tag, amount, owner, mint] = data.split(':');
  if ((tag !== 'b' && tag !== 's' && tag !== 't') || !amount || !owner || !mint) return null;
  const ownerId = Number.parseInt(owner, 36);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return null;
  return { tag, amount, owner: ownerId, mint };
}

/** What somebody can spend, in the sizes people actually trade. */
const BUY_SIZES = ['0.1', '0.5', '1', '2', '5'];
const SELL_SIZES = ['25', '50', '75', '100'];

export function buyKeyboard(owner: number, mint: string): InlineKeyboard {
  return {
    inline_keyboard: [
      BUY_SIZES.slice(0, 3).map((amount) => ({
        text: `Buy ${amount}`,
        callback_data: callbackData('b', amount, owner, mint),
      })),
      BUY_SIZES.slice(3).map((amount) => ({
        text: `Buy ${amount}`,
        callback_data: callbackData('b', amount, owner, mint),
      })),
      [{ text: 'Open on Probatio', url: `${SITE}/t/${mint}` }],
    ],
  };
}

/**
 * The verb once, then sizes.
 *
 * Four buttons each reading "Sell n%" is a row too wide for a phone, and three
 * of the words are the same word. The first carries the verb and the rest are
 * just the number, which is how somebody reads a row of sizes anyway.
 */
function sellRow(owner: number, mint: string): InlineKeyboard['inline_keyboard'][number] {
  return SELL_SIZES.map((amount, index) => ({
    text: index === 0 ? `Sell ${amount}%` : amount === '100' ? 'all' : `${amount}%`,
    callback_data: callbackData('s', amount, owner, mint),
  }));
}

export function sellKeyboard(owner: number, mint: string): InlineKeyboard {
  return {
    inline_keyboard: [sellRow(owner, mint), [{ text: 'Open on Probatio', url: `${SITE}/t/${mint}` }]],
  };
}

export interface TokenLabel {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string | null;
}

/**
 * What somebody typed, when it was a name rather than an address.
 *
 * Pasting forty-four characters is fine on a desktop and miserable on a phone,
 * which is where this bot is. A name gets a short list to tap instead, and
 * tapping one opens the same buy card the mint would have.
 *
 * The market cap is on the row because a name almost never picks out one token:
 * search "bonk" and there are a dozen, most of them worth nothing. The size is
 * how somebody tells the real one from the impostors, and leaving it off would
 * be handing them a list of identical names and wishing them luck.
 */
export interface Found {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly marketCapUsd: number | null;
}

function cap(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd) || usd <= 0) return '';
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}b`;
  if (usd >= 1_000_000) return `$${Math.round(usd / 1_000_000)}m`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}k`;
  return `$${Math.round(usd)}`;
}

export function matchesCard(query: string, found: readonly Found[]): string {
  return lines(
    html`${b(`${found.length} matching “${query}”`)}`,
    'Tap one to open it. Paste a mint instead if you already have the address.',
  );
}

/**
 * The season, as a card.
 *
 * Leads with whichever number is the reason to act right now: the time left to
 * enter while entry is open, and the time left to trade once it has closed.
 * A card that opened with the pot would be leading with a figure nobody can do
 * anything about.
 */
export function seasonCard(season: {
  name: string;
  status: string;
  entryCost: bigint;
  startingBalance: bigint;
  entrants: number;
  potLamports: bigint;
  paidPlaces: number;
  topPrize: bigint;
  entryClosesInMs: number | null;
  endsAt: number;
  nextBand: { places: number; entriesAway: number } | null;
  you: { rank: number; of: number; returnBps: number } | null;
  entered: boolean;
}, now: number): string {
  const open = season.entryClosesInMs !== null;
  const left = open ? season.entryClosesInMs! : Math.max(0, season.endsAt - now);

  return lines(
    html`${b(season.name)}`,
    open
      ? `${b(howLong(left))} left to enter`
      : `Entry is closed. ${b(howLong(left))} left to trade`,
    rows(
      `Entry ${b(`${formatSol(season.entryCost)} SOL`)}, and you trade with ${b(
        `${formatSol(season.startingBalance)} SOL`,
      )}`,
      `Pot ${b(`${formatSol(season.potLamports)} SOL`)} across ${season.entrants} entrant${
        season.entrants === 1 ? '' : 's'
      }, paying ${season.paidPlaces === 1 ? 'the winner' : `the top ${season.paidPlaces}`}`,
      season.topPrize > 0n ? `First place takes ${b(`${formatSol(season.topPrize)} SOL`)}` : '',
    ),
    /*
     * Only while entry is open, because after that it is a fact nobody can act
     * on, and it is the one line that gives somebody a reason to bring another
     * person in.
     */
    open && season.nextBand
      ? `${b(`${season.nextBand.entriesAway} more`)} and it pays the top ${season.nextBand.places} instead.`
      : '',
    season.you
      ? `You are ${b(`${ordinal(season.you.rank)} of ${season.you.of}`)}, ${
          season.you.returnBps >= 0 ? '+' : ''
        }${percent(season.you.returnBps)}`
      : season.entered
        ? 'You are entered. Place a fill and you will appear on the board.'
        : open
          ? `You are not entered. ${SITE}/season`
          : 'You are not in this one. The next season opens when this one ends.',
  );
}

function ordinal(place: number): string {
  const tens = place % 100;
  if (tens >= 11 && tens <= 13) return `${place}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[place % 10] ?? 'th';
  return `${place}${suffix}`;
}

/** One per match, newest and largest first, with the mint carried in the tap. */
export function matchesKeyboard(found: readonly Found[], owner: number): InlineKeyboard {
  return {
    inline_keyboard: found.map((token) => [
      {
        text: `${token.symbol || token.name}${cap(token.marketCapUsd) ? `  ${cap(token.marketCapUsd)}` : ''}`,
        // Amount is unused for a pick, but the payload shape is one shape.
        callback_data: callbackData('t', '0', owner, token.mint),
      },
    ]),
  };
}

function label(token: TokenLabel): string {
  return token.symbol ? `${token.name} (${token.symbol})` : token.name;
}

/** Before anything is bought: what it is, and what you have to spend. */
export function buyPrompt(token: TokenLabel, balance: bigint): string {
  return lines(
    rows(b(label(token)), code(token.mint)),
    `You have ${b(`${formatSol(balance)} SOL`)}.`,
    'Pick a size, or type /buy with one. The fill waits out the same latency the site does and is quoted against the pool as it stands after the wait.',
  );
}

export function sellPrompt(token: TokenLabel, held: HeldToken, decimals: number): string {
  const change =
    held.costBasis === 0n ? 0 : Number(((held.value - held.costBasis) * 10_000n) / held.costBasis);
  return lines(
    rows(b(label(token)), code(token.mint)),
    rows(
      `You hold ${b(tokens(held.tokenAmount, decimals))} tokens`,
      `Cost ${formatSol(held.costBasis)} SOL, worth ${b(`${formatSol(held.value)} SOL`)}${
        held.priced ? '' : ' (held at cost, no recent price)'
      }`,
      held.priced ? `${change >= 0 ? '+' : ''}${percent(change)}` : '',
    ),
    'Pick a size, or type /sell with one.',
  );
}

/**
 * The outcome, whatever it was.
 *
 * Every branch here is a thing that genuinely happens on a real chain, which is
 * why none of them are phrased as the bot going wrong.
 */
export function outcomeCard(
  outcome: ChatOutcome,
  token: TokenLabel,
  side: 'buy' | 'sell',
  trader: string,
  decimals: number,
): string {
  if (outcome.status === 'no_balance') {
    return 'Not enough SOL for that. /balance shows what you have.';
  }
  if (outcome.status === 'no_position') {
    return html`You do not hold ${label(token)}. Nothing was sold.`;
  }
  if (outcome.status === 'suspended') return outcome.detail;
  if (outcome.status === 'degraded') return outcome.detail;
  if (outcome.status === 'unlisted') return html`Cannot trade ${label(token)}: ${outcome.detail}`;

  if (outcome.status === 'rejected') {
    return lines(
      `${b(`${side === 'buy' ? 'Buy' : 'Sell'} rejected`)}: ${html`${outcome.detail}`}`,
      'Nothing was charged and no position changed. This is what the chain does too, which is why it happens here.',
    );
  }

  const { fill } = outcome;
  const asked = BigInt(side === 'buy' ? fill.expected.tokenAmount : fill.expected.solAmount);
  const got = BigInt(side === 'buy' ? fill.filled.tokenAmount : fill.filled.solAmount);
  const slip = asked === 0n ? 0 : Number(((got - asked) * 10_000n) / asked);

  const headline =
    side === 'buy'
      ? html`Bought ${b(`${tokens(got, decimals)} ${token.symbol ?? 'tokens'}`)} for ${b(
          `${formatSol(BigInt(fill.filled.solAmount))} SOL`,
        )}`
      : html`Sold ${b(`${tokens(BigInt(fill.filled.tokenAmount), decimals)} ${token.symbol ?? 'tokens'}`)} for ${b(
          `${formatSol(got)} SOL`,
        )}`;

  return lines(
    headline,
    rows(
      // The haircut, always. Showing only what filled is how every other paper
      // trader makes itself look better than it was.
      `Quoted ${side === 'buy' ? tokens(asked, decimals) : `${formatSol(asked)} SOL`}, filled ${
        side === 'buy' ? tokens(got, decimals) : `${formatSol(got)} SOL`
      } (${slip >= 0 ? '+' : ''}${percent(slip)})`,
      `Impact ${percent(fill.filled.priceImpactBps)}, fee ${formatSol(
        BigInt(fill.filled.feeLamports),
      )} SOL, waited ${fill.latencyMs}ms`,
      fill.filled.partial ? 'Partly filled: the pool could not take the whole size.' : '',
    ),
    rows(
      `Balance ${b(`${formatSol(BigInt(fill.balance))} SOL`)}`,
      side === 'sell' && BigInt(fill.realized) !== 0n
        ? `Realised ${b(
            `${BigInt(fill.realized) >= 0n ? '+' : ''}${formatSol(BigInt(fill.realized))} SOL`,
          )}`
        : '',
    ),
    html`Sealed as fill #${fill.sequence}. ${SITE}/p/${trader}`,
  );
}

export function balanceCard(portfolio: Portfolio): string {
  const basis = portfolio.startingBalance;
  const change = basis === 0n ? 0 : Number(((portfolio.equity - basis) * 10_000n) / basis);
  const unpriced = portfolio.held.filter((token) => !token.priced).length;

  return lines(
    `${b(`${formatSol(portfolio.equity)} SOL`)} total, ${change >= 0 ? '+' : ''}${percent(
      change,
    )} from ${formatSol(basis)} SOL`,
    rows(
      portfolio.held.length === 0
        ? `${formatSol(portfolio.solBalance)} SOL free, nothing open`
        : `${formatSol(portfolio.solBalance)} SOL free, across ${portfolio.held.length} position${
            portfolio.held.length === 1 ? '' : 's'
          }`,
      portfolio.realizedPnl === 0n
        ? ''
        : `Realised ${portfolio.realizedPnl >= 0n ? '+' : ''}${formatSol(portfolio.realizedPnl)} SOL`,
      unpriced === 0 ? '' : `${unpriced} held at cost, with no recent price`,
      portfolio.ranked ? 'Ranked season' : 'Free play',
    ),
    html`${SITE}/p/${portfolio.pubkey}`,
  );
}

export function positionsCard(portfolio: Portfolio, names: ReadonlyMap<string, TokenLabel>): string {
  if (portfolio.held.length === 0) {
    return lines(
      b('Nothing open.'),
      `${formatSol(portfolio.solBalance)} SOL free. /buy &lt;mint&gt; to open something.`,
    );
  }

  const held = portfolio.held.map((token) => {
    const name = names.get(token.mint);
    const change =
      token.costBasis === 0n
        ? 0
        : Number(((token.value - token.costBasis) * 10_000n) / token.costBasis);
    return html`${b(name ? label(name) : shortMint(token.mint))}  ${formatSol(token.value)} SOL  ${
      change >= 0 ? '+' : ''
    }${percent(change)}${token.priced ? '' : '  (at cost)'}`;
  });

  return lines(
    rows(...held),
    `${formatSol(portfolio.solBalance)} SOL free, ${b(`${formatSol(portfolio.equity)} SOL`)} total`,
  );
}

/**
 * A row of sizes per open position.
 *
 * The token's name appears on a row only when there is more than one row, since
 * naming it is there to say which holding a row belongs to and with a single
 * holding there is nothing to tell it apart from. On one position it read as
 * the button repeating what the line above it had just said.
 *
 * Telegram takes a long keyboard, but a phone does not: past this many rows the
 * card is longer than the screen and the list above it is out of sight.
 */
const MAX_ROWS = 6;

export function positionsKeyboard(
  portfolio: Portfolio,
  names: ReadonlyMap<string, TokenLabel>,
  owner: number,
): InlineKeyboard | undefined {
  if (portfolio.held.length === 0) return undefined;
  const many = portfolio.held.length > 1;

  const keyboard = portfolio.held.slice(0, MAX_ROWS).map((token) => {
    if (!many) return sellRow(owner, token.mint);

    const name = names.get(token.mint);
    const label = name?.symbol ?? shortMint(token.mint);
    return SELL_SIZES.map((amount, index) => ({
      text: index === 0 ? `${label} ${amount}%` : amount === '100' ? 'all' : `${amount}%`,
      callback_data: callbackData('s', amount, owner, token.mint),
    }));
  });
  return { inline_keyboard: keyboard };
}
