import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram } from '../transport';
import { route } from '../router';
import { callbackData } from '../trade-cards';
import type { Update } from '../types';
import type { ChatTrade } from '../trade';

/**
 * Buying and selling from a chat, without a chat.
 *
 * The fill itself is `executeTrade`'s and is tested where it lives. What is
 * tested here is everything a chat adds around it: whose account a message
 * belongs to, and who is allowed to press a button.
 */

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const links = new Map<number, string>();
const placed: ChatTrade[] = [];
const searched: string[] = [];

vi.mock('../../token-search', () => ({
  searchExternalTokens: async (query: string) => {
    searched.push(query);
    return [
      { mint: MINT, name: 'Bonk', symbol: 'BONK', image: null, marketCapUsd: 1_200_000_000 },
      { mint: 'So11111111111111111111111111111111111111112', name: 'Bonk Inu', symbol: 'BONKI', image: null, marketCapUsd: 4_000 },
    ];
  },
}));

vi.mock('../../db', () => ({ db: async () => ({}) }));
vi.mock('../../token-name', () => ({
  resolveTokenName: async () => ({ name: 'Bonk', symbol: 'BONK', known: true }),
}));
vi.mock('@probatio/db', () => ({
  CODE_TTL_MS: 600_000,
  issueLinkCode: async () => ({ code: 'AAAAAAAA' }),
  unlinkTelegram: async () => true,
  linkedWallet: async (_client: unknown, telegramId: number) => links.get(telegramId) ?? null,
}));
vi.mock('../verify', async (original) => ({
  ...(await original<typeof import('../verify')>()),
  verifyWallet: async (trader: string) => ({ trader, record: null, empty: true, unreachable: false }),
}));
vi.mock('../trade', async (original) => ({
  ...(await original<typeof import('../trade')>()),
  tradeFromChat: async (request: ChatTrade) => {
    placed.push(request);
    return {
      status: 'filled' as const,
      fill: {
        tradeId: 1,
        sequence: 1,
        side: request.side,
        mint: request.mint,
        expected: { solAmount: '1000000000', tokenAmount: '1000000' },
        filled: {
          solAmount: '1000000000',
          tokenAmount: '1000000',
          feeLamports: '0',
          priceImpactBps: 10,
          partial: false,
        },
        slippageBps: 100,
        latencyMs: 400,
        balance: '9000000000',
        position: { tokenAmount: '1000000', costBasis: '1000000000', realizedPnl: '0' },
        realized: '0',
      },
    };
  },
  portfolioFor: async (pubkey: string) => ({
    pubkey,
    ranked: false,
    solBalance: 10_000_000_000n,
    startingBalance: 10_000_000_000n,
    held: [
      {
        mint: MINT,
        tokenAmount: 1_000_000n,
        costBasis: 1_000_000_000n,
        value: 1_200_000_000n,
        priced: true,
      },
    ],
    equity: 11_200_000_000n,
    realizedPnl: 0n,
  }),
}));

function typed(text: string, from = 42, chat: 'private' | 'group' = 'private'): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_800_000_000,
      from: { id: from, first_name: 'Someone' },
      chat: { id: -100, type: chat },
      text,
    },
  };
}

function tapped(data: string, from: number): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb1',
      from: { id: from, first_name: 'Someone' },
      data,
      message: {
        message_id: 11,
        date: 1_800_000_000,
        chat: { id: -100, type: 'group' },
        text: 'a card',
      },
    },
  };
}

async function run(update: Update): Promise<FakeTelegram> {
  const telegram = new FakeTelegram();
  const { HANDLERS } = await import('../handlers');
  await route(update, telegram, HANDLERS);
  return telegram;
}

beforeEach(() => {
  links.clear();
  placed.length = 0;
  searched.length = 0;
});

describe('/buy', () => {
  it('places a buy for the size that was typed', async () => {
    links.set(42, WALLET);
    await run(typed(`/buy ${MINT} 0.5`));
    expect(placed).toEqual([
      { pubkey: WALLET, mint: MINT, side: 'buy', amount: 500_000_000n, now: expect.any(Number) },
    ]);
  });

  /*
   * A size has to be asked for, never guessed. A bot that picks a number for
   * somebody has spent their money for them.
   */
  it('offers sizes rather than choosing one', async () => {
    links.set(42, WALLET);
    const telegram = await run(typed(`/buy ${MINT}`));
    expect(placed).toEqual([]);
    expect(telegram.sent[0]?.reply_markup?.inline_keyboard.length).toBeGreaterThan(0);
  });

  it('will not trade for somebody with no account connected', async () => {
    const telegram = await run(typed(`/buy ${MINT} 0.5`));
    expect(placed).toEqual([]);
    expect(telegram.sent[0]?.text).toContain('/link');
  });

  it('refuses a size it cannot read instead of guessing at it', async () => {
    links.set(42, WALLET);
    const telegram = await run(typed(`/buy ${MINT} lots`));
    expect(placed).toEqual([]);
    expect(telegram.sent[0]?.text).toContain('cannot read');
  });

  /*
   * Pasting forty-four characters is fine on a desktop and miserable on a
   * phone, which is where this bot is.
   */
  it('offers matches when given a name rather than an address', async () => {
    links.set(42, WALLET);
    const telegram = await run(typed('/buy bonk'));

    expect(placed).toEqual([]);
    expect(telegram.last()).toContain('matching');
    const row = telegram.sent[0]?.reply_markup?.inline_keyboard[0]?.[0];
    expect(row?.text).toContain('BONK');
    expect(row?.callback_data?.startsWith('t:')).toBe(true);
  });

  /*
   * A name can contain spaces and the last word may or may not be a size, so
   * the rule is that a trailing word which parses as one is a size.
   */
  it('separates a multi word name from a trailing size', async () => {
    links.set(42, WALLET);
    await run(typed('/buy baby doge 0.5'));
    expect(searched).toEqual(['baby doge']);

    searched.length = 0;
    await run(typed('/buy baby doge'));
    expect(searched).toEqual(['baby doge']);
  });

  /*
   * Opening a card, not placing a trade. The size is still chosen deliberately
   * rather than inherited from whichever button got them here.
   */
  it('turns a tapped match into a buy card rather than a fill', async () => {
    links.set(42, WALLET);
    const telegram = await run(tapped(callbackData('t', '0', 42, MINT), 42));

    expect(placed).toEqual([]);
    expect(telegram.last()).toContain('Pick a size');
    expect(telegram.sent[0]?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Buy');
  });

  it('asks for a token when there is none', async () => {
    links.set(42, WALLET);
    const telegram = await run(typed('/buy'));
    expect(placed).toEqual([]);
    expect(telegram.sent[0]?.text).toContain('Give me a token');
  });

  /*
   * Somebody who has just bought is one tap from being able to get out again.
   * That is the point of a fill card rather than a receipt.
   */
  it('leaves a way out on the fill card', async () => {
    links.set(42, WALLET);
    const telegram = await run(typed(`/buy ${MINT} 0.5`));
    const button = telegram.sent[0]?.reply_markup?.inline_keyboard[0]?.[0];
    expect(button?.text).toContain('Sell');
  });
});

describe('/sell by name', () => {
  /*
   * Selling is only ever about a position that already exists, so the answer is
   * in a list this bot already has. Searching an outside index would be slower,
   * would sometimes return a different token of the same name, and could offer
   * to sell something they do not own.
   */
  it('matches what you hold instead of searching', async () => {
    links.set(42, WALLET);
    await run(typed('/sell bonk 50'));

    expect(searched).toEqual([]);
    expect(placed[0]).toMatchObject({ mint: MINT, side: 'sell', amount: 50 });
  });

  it('says so when you hold nothing by that name, and places nothing', async () => {
    links.set(42, WALLET);
    const telegram = await run(typed('/sell wif 50'));

    expect(placed).toEqual([]);
    expect(telegram.last()).toContain('do not hold anything');
  });
});

describe('/sell', () => {
  it('sells a share of the position rather than a token amount', async () => {
    links.set(42, WALLET);
    await run(typed(`/sell ${MINT} 50`));
    expect(placed[0]).toMatchObject({ side: 'sell', amount: 50 });
  });

  it('reads "all" the way somebody means it', async () => {
    links.set(42, WALLET);
    await run(typed(`/sell ${MINT} all`));
    expect(placed[0]).toMatchObject({ side: 'sell', amount: 100 });
  });
});

describe('a tap on somebody’s card', () => {
  it('trades for the person it belongs to', async () => {
    links.set(42, WALLET);
    const telegram = await run(tapped(callbackData('b', '1', 42, MINT), 42));
    expect(placed[0]).toMatchObject({ pubkey: WALLET, side: 'buy', amount: 1_000_000_000n });
    // Answered before the fill, or the button spins for as long as the fill takes.
    expect(telegram.answered[0]?.callback_query_id).toBe('cb1');
  });

  /*
   * The one that matters in a group. Anybody can tap anybody's buttons, and
   * without the owner in the payload a stranger's tap places a real fill on
   * somebody else's public record. The money is practice; the record is not.
   */
  it('refuses a stranger, and places nothing', async () => {
    links.set(42, WALLET);
    links.set(99, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    const telegram = await run(tapped(callbackData('b', '1', 42, MINT), 99));
    expect(placed).toEqual([]);
    expect(telegram.answered[0]?.show_alert).toBe(true);
    expect(telegram.sent).toEqual([]);
  });

  it('answers a tap from somebody with no account, rather than leaving it spinning', async () => {
    const telegram = await run(tapped(callbackData('b', '1', 42, MINT), 42));
    expect(placed).toEqual([]);
    expect(telegram.answered[0]?.text).toContain('/link');
  });
});
