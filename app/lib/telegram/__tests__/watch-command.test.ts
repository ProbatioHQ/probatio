import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram } from '../transport';
import { route } from '../router';
import type { Update } from '../types';

/**
 * Subscribing a chat to a trader.
 *
 * Keyed on the chat rather than the person, unlike the account link: a watch is
 * a thing a room subscribes to, so anybody in the room can add one and anybody
 * can remove one. Which is exactly why there is a ceiling.
 */

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const watched = new Map<number, Set<string>>();
let refuse: 'too_many' | null = null;

vi.mock('../../db', () => ({ db: async () => ({}) }));
vi.mock('../../token-name', () => ({
  resolveTokenName: async () => ({ name: 'Bonk', symbol: 'BONK', known: true }),
}));
vi.mock('@probatio/db', () => ({
  CODE_TTL_MS: 600_000,
  MAX_WATCHES_PER_CHAT: 10,
  issueLinkCode: async () => ({ code: 'AAAAAAAA' }),
  unlinkTelegram: async () => true,
  linkedWallet: async () => null,
  watchTrader: async (_client: unknown, { chatId, trader }: { chatId: number; trader: string }) => {
    if (refuse) return refuse;
    const room = watched.get(chatId) ?? new Set<string>();
    if (room.has(trader)) return 'already';
    room.add(trader);
    watched.set(chatId, room);
    return 'added';
  },
  unwatchTrader: async (_client: unknown, chatId: number, trader: string) =>
    watched.get(chatId)?.delete(trader) ?? false,
  watchesFor: async (_client: unknown, chatId: number) =>
    [...(watched.get(chatId) ?? [])].map((trader, index) => ({
      id: index,
      chatId,
      telegramUserId: 1,
      trader,
      lastTradeId: 0,
      createdAt: 0,
    })),
}));
vi.mock('../verify', async (original) => ({
  ...(await original<typeof import('../verify')>()),
  verifyWallet: async (trader: string) => ({ trader, record: null, empty: true, unreachable: false }),
}));

function typed(text: string, reply?: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_800_000_000,
      from: { id: 42, first_name: 'Someone' },
      chat: { id: -100, type: 'group' },
      text,
      ...(reply
        ? {
            reply_to_message: {
              message_id: 9,
              date: 1_799_999_000,
              chat: { id: -100, type: 'group' as const },
              text: reply,
            },
          }
        : {}),
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
  watched.clear();
  refuse = null;
});

describe('/watch', () => {
  it('subscribes the chat, and says it starts from now', async () => {
    const telegram = await run(typed(`/watch ${A}`));
    expect(watched.get(-100)?.has(A)).toBe(true);
    expect(telegram.last()).toContain('Nothing from before');
  });

  /*
   * The same gesture /verify uses. Somebody posts about a wallet, and following
   * them is a reply rather than a copy and paste.
   */
  it('takes the wallet out of a message it is replying to', async () => {
    await run(typed('/watch', `keep an eye on ${A}`));
    expect(watched.get(-100)?.has(A)).toBe(true);
  });

  it('does not need an account of its own', async () => {
    // linkedWallet returns null throughout: a watch delivers fills that are
    // already on a public profile, so it asks nobody's permission.
    const telegram = await run(typed(`/watch ${A}`));
    expect(telegram.last()).not.toContain('/link');
  });

  it('says so rather than subscribing twice', async () => {
    await run(typed(`/watch ${A}`));
    const telegram = await run(typed(`/watch ${A}`));
    expect(telegram.last()).toContain('Already watching');
  });

  it('points at the way out when a room is full', async () => {
    refuse = 'too_many';
    const telegram = await run(typed(`/watch ${A}`));
    expect(telegram.last()).toContain('/unwatch');
  });

  it('asks for a wallet rather than guessing at one', async () => {
    const telegram = await run(typed('/watch'));
    expect(telegram.last()).toContain('Give me a wallet');
    expect(watched.size).toBe(0);
  });
});

describe('/unwatch and /watching', () => {
  it('stops, and says whether it was watching', async () => {
    await run(typed(`/watch ${A}`));
    expect((await run(typed(`/unwatch ${A}`))).last()).toContain('Stopped watching');
    expect((await run(typed(`/unwatch ${A}`))).last()).toContain('was not watching');
  });

  it('lists what the chat follows, and how much room is left', async () => {
    await run(typed(`/watch ${A}`));
    const telegram = await run(typed('/watching'));
    expect(telegram.last()).toContain('<b>1 of 10</b>');
    expect(telegram.last()).toContain(A);
  });

  it('says plainly when a chat follows nobody', async () => {
    expect((await run(typed('/watching'))).last()).toContain('not watching anybody');
  });
});
