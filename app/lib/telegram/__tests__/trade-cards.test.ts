import { describe, expect, it } from 'vitest';
import {
  balanceCard,
  seasonCard,
  buyKeyboard,
  callbackData,
  outcomeCard,
  parseAction,
  positionsCard,
  positionsKeyboard,
  sellKeyboard,
} from '../trade-cards';
import { formatSol, parsePercent, parseSol } from '../trade';
import type { Portfolio, HeldToken } from '../trade';
import type { TokenLabel } from '../trade-cards';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const TRADER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TOKEN: TokenLabel = { mint: MINT, name: 'Bonk', symbol: 'BONK' };

/**
 * Sizes as people type them.
 *
 * Parsed as decimal strings rather than through a float, because 0.1 is not
 * representable in binary and a lamport balance is an integer.
 */
describe('reading a size', () => {
  it('turns SOL into lamports exactly', () => {
    expect(parseSol('1')).toBe(1_000_000_000n);
    expect(parseSol('0.1')).toBe(100_000_000n);
    expect(parseSol('0.000000001')).toBe(1n);
    expect(parseSol(' 2.5 ')).toBe(2_500_000_000n);
  });

  it('refuses what is not a size', () => {
    expect(parseSol('0')).toBeNull();
    expect(parseSol('')).toBeNull();
    expect(parseSol('all')).toBeNull();
    expect(parseSol('1e9')).toBeNull();
    // Below a lamport is not a size, it is a rounding error waiting to happen.
    expect(parseSol('0.0000000001')).toBeNull();
  });

  it('reads a share of a position the way people say it', () => {
    expect(parsePercent('50')).toBe(50);
    expect(parsePercent('50%')).toBe(50);
    expect(parsePercent('all')).toBe(100);
    expect(parsePercent('half')).toBe(50);
    expect(parsePercent('0')).toBeNull();
    expect(parsePercent('120')).toBeNull();
  });

  it('prints lamports back without exponents', () => {
    expect(formatSol(1_000_000_000n)).toBe('1');
    expect(formatSol(1_500_000_000n)).toBe('1.5');
    expect(formatSol(-250_000_000n)).toBe('-0.25');
    expect(formatSol(0n)).toBe('0');
  });
});

/*
 * Telegram silently refuses a keyboard whose callback data exceeds sixty four
 * bytes, and the failure looks like the card never appearing. A mint is
 * forty-four of those bytes on its own.
 */
describe('button payloads fit', () => {
  it('stays inside Telegram’s limit with the longest realistic mint', () => {
    const owner = 9_999_999_999;
    for (const row of buyKeyboard(owner, MINT).inline_keyboard) {
      for (const button of row) {
        if (button.callback_data) expect(button.callback_data.length).toBeLessThanOrEqual(64);
      }
    }
    for (const row of sellKeyboard(owner, MINT).inline_keyboard) {
      for (const button of row) {
        if (button.callback_data) expect(button.callback_data.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('round trips', () => {
    const data = callbackData('b', '0.5', 123_456, MINT);
    expect(parseAction(data)).toEqual({ tag: 'b', amount: '0.5', owner: 123_456, mint: MINT });
  });

  it('refuses payloads it did not write', () => {
    expect(parseAction('b:0.5')).toBeNull();
    expect(parseAction('x:0.5:1:' + MINT)).toBeNull();
    // An owner of zero is the placeholder a missing Telegram id would produce,
    // and a card nobody owns is a card anybody could press.
    expect(parseAction(`b:0.5:0:${MINT}`)).toBeNull();
  });
});

function held(over: Partial<HeldToken> = {}): HeldToken {
  return {
    mint: MINT,
    tokenAmount: 1_000_000_000n,
    costBasis: 1_000_000_000n,
    value: 1_500_000_000n,
    priced: true,
    ...over,
  };
}

function portfolio(over: Partial<Portfolio> = {}): Portfolio {
  const positions = over.held ?? [held()];
  return {
    pubkey: TRADER,
    ranked: false,
    solBalance: 8_000_000_000n,
    startingBalance: 10_000_000_000n,
    held: positions,
    equity: positions.reduce((total, token) => total + token.value, 8_000_000_000n),
    realizedPnl: 0n,
    ...over,
  };
}

describe('what a fill card says', () => {
  const fill = {
    tradeId: 1,
    sequence: 7,
    side: 'buy' as const,
    mint: MINT,
    expected: { solAmount: '1000000000', tokenAmount: '1000000' },
    filled: {
      solAmount: '1000000000',
      tokenAmount: '950000',
      feeLamports: '10000000',
      priceImpactBps: 120,
      partial: false,
    },
    slippageBps: 100,
    latencyMs: 400,
    balance: '7000000000',
    position: { tokenAmount: '950000', costBasis: '1000000000', realizedPnl: '0' },
    realized: '0',
  };

  /*
   * The one thing this card must never do. Every other paper trader shows the
   * quote and calls it a fill; printing only what filled would put that lie
   * back in at the last step.
   */
  it('prints what was asked for beside what was got', () => {
    const text = outcomeCard({ status: 'filled', fill }, TOKEN, 'buy', TRADER, 6);
    expect(text).toContain('Quoted');
    expect(text).toContain('filled');
    expect(text).toContain('-5.00%');
    expect(text).toContain('Impact 1.20%');
    expect(text).toContain('Sealed as fill #7');
  });

  it('says a rejection plainly, and says nothing changed', () => {
    const text = outcomeCard(
      { status: 'rejected', reason: 'slippage', detail: 'the price moved past your limit' },
      TOKEN,
      'buy',
      TRADER,
      6,
    );
    expect(text).toContain('rejected');
    expect(text).toContain('Nothing was charged');
  });

  it('does not present a suspension or an unreadable chain as a trade', () => {
    const suspended = outcomeCard(
      { status: 'suspended', detail: 'This token is suspended.' },
      TOKEN,
      'buy',
      TRADER,
      6,
    );
    expect(suspended).toBe('This token is suspended.');
    expect(outcomeCard({ status: 'no_balance' }, TOKEN, 'buy', TRADER, 6)).toContain('Not enough SOL');
    expect(outcomeCard({ status: 'no_position', mint: MINT }, TOKEN, 'sell', TRADER, 6)).toContain(
      'do not hold',
    );
  });

  it('says when a fill was only partly taken', () => {
    const text = outcomeCard(
      { status: 'filled', fill: { ...fill, filled: { ...fill.filled, partial: true } } },
      TOKEN,
      'buy',
      TRADER,
      6,
    );
    expect(text).toContain('Partly filled');
  });
});

describe('the portfolio cards', () => {
  it('measures return against what the account started with', () => {
    const text = balanceCard(portfolio());
    // 8 free plus 1.5 held against 10 started with.
    expect(text).toContain('<b>9.5 SOL</b> total');
    expect(text).toContain('-5.00%');
    expect(text).toContain('Free play');
  });

  /*
   * A position with no recent candle is carried at what it cost and said to be.
   * Marking it at zero would read as a loss that never happened.
   */
  it('says which positions are held at cost rather than marked', () => {
    const text = balanceCard(portfolio({ held: [held({ priced: false, value: 1_000_000_000n })] }));
    expect(text).toContain('held at cost');
    expect(positionsCard(portfolio({ held: [held({ priced: false, value: 1_000_000_000n })] }), new Map()))
      .toContain('(at cost)');
  });

  it('offers nothing to sell when nothing is open', () => {
    const empty = portfolio({ held: [], equity: 8_000_000_000n });
    expect(positionsCard(empty, new Map())).toContain('Nothing open');
    // "across 0 positions" reads like a number that failed to render.
    expect(balanceCard(empty)).toContain('nothing open');
    expect(positionsKeyboard(empty, new Map(), 42)).toBeUndefined();
  });

  /*
   * A row of sizes rather than one button that sells the lot. Trimming is the
   * common case and it was the case that needed the mint typed out again.
   */
  it('offers every size on an open position', () => {
    const names = new Map([[MINT, TOKEN]]);
    const row = positionsKeyboard(portfolio(), names, 42)?.inline_keyboard[0];

    expect(row?.map((button) => button.text)).toEqual(['Sell 25%', '50%', '75%', 'all']);
    expect(row?.map((button) => parseAction(button.callback_data ?? '')?.amount)).toEqual([
      '25',
      '50',
      '75',
      '100',
    ]);
    for (const button of row ?? []) {
      expect(parseAction(button.callback_data ?? '')).toMatchObject({ tag: 's', owner: 42 });
      expect(button.callback_data!.length).toBeLessThanOrEqual(64);
    }
  });

  /*
   * Naming the token is there to say which holding a row belongs to. With one
   * holding there is nothing to tell it apart from, and the button just repeats
   * the line above it.
   */
  it('names the token only when there is more than one to tell apart', () => {
    const names = new Map([[MINT, TOKEN], [OTHER_MINT, { mint: OTHER_MINT, name: 'Wif', symbol: 'WIF' }]]);
    const two = portfolio({ held: [held(), held({ mint: OTHER_MINT })] });
    const keyboard = positionsKeyboard(two, names, 42)?.inline_keyboard;

    expect(keyboard?.[0]?.[0]?.text).toBe('BONK 25%');
    expect(keyboard?.[1]?.[0]?.text).toBe('WIF 25%');
    expect(keyboard?.[0]?.map((button) => button.text)).toEqual(['BONK 25%', '50%', '75%', 'all']);
  });
});

/**
 * The season, for somebody standing in a chat.
 *
 * The bot could trade all day without mentioning that a competition is running,
 * which is the state it was in. What it leads with is the whole design: the
 * number somebody can act on right now, rather than the biggest one.
 */
describe('the season card', () => {
  const NOW = 1_787_500_000_000;

  function season(over: Partial<Parameters<typeof seasonCard>[0]> = {}) {
    return {
      name: 'Season 1',
      status: 'entry_open',
      entryCost: 50_000_000n,
      startingBalance: 10_000_000_000n,
      entrants: 4,
      potLamports: 200_000_000n,
      paidPlaces: 1,
      topPrize: 180_000_000n,
      entryClosesInMs: 216_000_000,
      endsAt: NOW + 600_000_000,
      nextBand: { places: 3, entriesAway: 16 },
      you: null,
      entered: false,
      ...over,
    };
  }

  it('leads with the time left to enter while entry is open', () => {
    const text = seasonCard(season(), NOW);
    expect(text.split('\n\n')[1]).toContain('left to enter');
    expect(text).toContain('2 days 12 hours');
  });

  /*
   * Once entry has closed the deadline is a fact nobody can act on, and the
   * thing that matters is how long there is left to trade.
   */
  it('leads with the time left to trade once entry has closed', () => {
    const text = seasonCard(season({ entryClosesInMs: null }), NOW);
    expect(text).toContain('Entry is closed');
    expect(text).toContain('left to trade');
  });

  it('prints the pot, the field and what first place takes', () => {
    const text = seasonCard(season(), NOW);
    expect(text).toContain('0.05 SOL');
    expect(text).toContain('10 SOL');
    expect(text).toContain('4 entrants');
    expect(text).toContain('paying the winner');
    expect(text).toContain('0.18 SOL');
  });

  /*
   * The one line that gives somebody a reason to bring another person in, and
   * the one line that is pointless after the door shuts.
   */
  it('shows the next payout band only while entry is open', () => {
    expect(seasonCard(season(), NOW)).toContain('16 more');
    expect(seasonCard(season({ entryClosesInMs: null }), NOW)).not.toContain('16 more');
  });

  it('says where you stand when you are in it', () => {
    const text = seasonCard(season({ entered: true, you: { rank: 2, of: 4, returnBps: 1_250 } }), NOW);
    expect(text).toContain('2nd of 4');
    expect(text).toContain('+12.50%');
  });

  it('handles the awkward ordinals', () => {
    for (const [rank, want] of [[1, '1st'], [3, '3rd'], [11, '11th'], [21, '21st'], [113, '113th']] as const) {
      const text = seasonCard(season({ entered: true, you: { rank, of: 200, returnBps: 0 } }), NOW);
      expect(text).toContain(`${want} of 200`);
    }
  });

  it('points somebody who is not entered at the way in', () => {
    expect(seasonCard(season(), NOW)).toContain('not entered');
    expect(seasonCard(season({ entryClosesInMs: null }), NOW)).toContain('next season');
  });
});
