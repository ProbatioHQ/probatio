import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram } from '../transport';
import { route } from '../router';
import type { Update } from '../types';

/**
 * Anything carrying markup has to say so.
 *
 * Telegram only parses a message when it is told to. A card built with bold and
 * monospace and sent without `parse_mode` does not fail, it renders the tags as
 * characters, and the sender is the last person to find out. That is exactly
 * what happened to the verify card: the trade cards were converted and its own
 * send was missed, so it went out reading "<b>… verifies.</b>" in the middle of
 * a sentence.
 *
 * So rather than checking that one call again, this walks every message the bot
 * can produce and holds the invariant: markup implies parse_mode, and
 * parse_mode implies nothing unescaped.
 */

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

vi.mock('../../db', () => ({ db: async () => ({}) }));
vi.mock('../../token-name', () => ({
  resolveTokenName: async () => ({ name: 'Bonk', symbol: 'BONK', known: true }),
}));
vi.mock('@probatio/db', () => ({
  CODE_TTL_MS: 600_000,
  MAX_WATCHES_PER_CHAT: 10,
  issueLinkCode: async () => ({ code: 'AAAAAAAA' }),
  unlinkTelegram: async () => true,
  linkedWallet: async () => WALLET,
  watchTrader: async () => 'added',
  unwatchTrader: async () => true,
  watchesFor: async () => [
    { id: 1, chatId: -100, telegramUserId: 42, trader: WALLET, lastTradeId: 0, createdAt: 0 },
  ],
}));
/*
 * A record that verifies, so the card actually carries bold and monospace. An
 * empty record has no markup in it and would have passed the broken version.
 */
vi.mock('../verify', async (original) => ({
  ...(await original<typeof import('../verify')>()),
  verifyWallet: async (trader: string) => ({
    trader,
    record: {
      trader,
      seasonOrdinal: 0,
      verified: true,
      root: 'ab'.repeat(32),
      broken: [],
      tradeCount: 22,
      checks: [],
    },
    empty: false,
    unreachable: false,
  }),
}));
vi.mock('../season', async (original) => ({
  ...(await original<typeof import('../season')>()),
  seasonNow: async () => ({
    name: 'Season 1',
    status: 'entry_open',
    entryCost: 50_000_000n,
    startingBalance: 10_000_000_000n,
    entrants: 4,
    potLamports: 200_000_000n,
    paidPlaces: 1,
    topPrize: 180_000_000n,
    entryClosesInMs: 216_000_000,
    endsAt: 1_787_904_000_000,
    nextBand: { places: 3, entriesAway: 16 },
    you: { rank: 2, of: 4, returnBps: 1_250 },
    entered: true,
  }),
}));
vi.mock('../trade', async (original) => ({
  ...(await original<typeof import('../trade')>()),
  portfolioFor: async (pubkey: string) => ({
    pubkey,
    ranked: false,
    solBalance: 9_000_000_000n,
    startingBalance: 10_000_000_000n,
    held: [
      {
        mint: MINT,
        tokenAmount: 500_000_000n,
        costBasis: 1_000_000_000n,
        value: 1_200_000_000n,
        priced: true,
      },
    ],
    equity: 10_200_000_000n,
    realizedPnl: 0n,
  }),
}));

function typed(text: string, chat: 'private' | 'group' = 'private'): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_800_000_000,
      from: { id: 42, first_name: 'Someone' },
      chat: { id: chat === 'group' ? -100 : 42, type: chat },
      text,
    },
  };
}

/** Everything a person can type, in both kinds of chat. */
const EVERY_COMMAND = [
  '/start',
  '/help',
  '/link',
  '/unlink',
  `/verify ${WALLET}`,
  '/verify',
  `/buy ${MINT}`,
  `/buy ${MINT} notasize`,
  '/buy',
  `/sell ${MINT}`,
  `/sell ${MINT} notashare`,
  '/sell',
  '/positions',
  '/balance',
  '/season',
  `/watch ${WALLET}`,
  '/watch',
  `/unwatch ${WALLET}`,
  '/watching',
];

const MARKUP = /<\/?(b|i|u|s|code|pre|a|blockquote)\b/;

beforeEach(() => vi.clearAllMocks());

describe('every message the bot can send', () => {
  it('declares HTML whenever it contains any', async () => {
    const { HANDLERS } = await import('../handlers');

    for (const chat of ['private', 'group'] as const) {
      for (const command of EVERY_COMMAND) {
        const telegram = new FakeTelegram();
        await route(typed(command, chat), telegram, HANDLERS);

        for (const message of telegram.sent) {
          if (MARKUP.test(message.text)) {
            expect(message.parse_mode, `${command} in a ${chat} chat`).toBe('HTML');
          }
        }
        for (const answer of telegram.inline) {
          for (const result of answer.results) {
            if (MARKUP.test(result.input_message_content.message_text)) {
              expect(result.input_message_content.parse_mode, command).toBe('HTML');
            }
          }
        }
      }
    }
  });

  /*
   * The other direction. A bare angle bracket in a message declared as HTML is
   * either markup nobody meant or a message Telegram refuses outright, and a
   * refused message is silence rather than an error.
   */
  it('leaves nothing unescaped in a message it declared as HTML', async () => {
    const { HANDLERS } = await import('../handlers');

    for (const chat of ['private', 'group'] as const) {
      for (const command of EVERY_COMMAND) {
        const telegram = new FakeTelegram();
        await route(typed(command, chat), telegram, HANDLERS);

        for (const message of telegram.sent) {
          if (message.parse_mode !== 'HTML') continue;
          // Strip the tags this code is allowed to write, then nothing sharp
          // may be left.
          const bare = message.text
            .replace(/<\/?(b|i|u|s|code|pre|blockquote|a)>/g, '')
            .replace(/<a href="[^"]*">/g, '')
            .replace(/&lt;|&gt;|&amp;/g, '');
          expect(bare, `${command} in a ${chat} chat`).not.toMatch(/[<>]/);
        }
      }
    }
  });

  /*
   * The inline path is the one that runs in chats nobody here controls, and it
   * is answered from a different branch to everything above.
   */
  it('holds for an inline query too', async () => {
    const { HANDLERS } = await import('../handlers');
    const telegram = new FakeTelegram();
    await route(
      {
        update_id: 2,
        inline_query: { id: 'q', from: { id: 42, first_name: 'A' }, query: WALLET, offset: '' },
      },
      telegram,
      HANDLERS,
    );

    const result = telegram.inline[0]?.results[0];
    expect(result?.input_message_content.message_text).toMatch(MARKUP);
    expect(result?.input_message_content.parse_mode).toBe('HTML');
  });
});
