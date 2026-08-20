import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram } from '../transport';
import { route } from '../router';
import type { Update } from '../types';

/**
 * Which wallet a /verify is about.
 *
 * Three ways of naming one, because in a chat people have three different
 * things in hand. This is the part worth testing: getting it wrong means the
 * bot confidently checks the wrong person's record, which is worse than
 * checking nobody's.
 */

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

const links = new Map<number, string>();
const checked: string[] = [];

vi.mock('../../db', () => ({ db: async () => ({}) }));
vi.mock('@probatio/db', () => ({
  CODE_TTL_MS: 600_000,
  issueLinkCode: async () => ({ code: 'AAAAAAAA' }),
  unlinkTelegram: async () => true,
  linkedWallet: async (_client: unknown, telegramId: number) => links.get(telegramId) ?? null,
}));
vi.mock('../verify', async (original) => ({
  ...(await original<typeof import('../verify')>()),
  verifyWallet: async (trader: string) => {
    checked.push(trader);
    return { trader, record: null, empty: true, unreachable: false };
  },
}));

function update(text: string, over: Partial<{ from: number; chat: 'private' | 'group'; reply: { text?: string; from?: number } }> = {}): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_800_000_000,
      from: { id: over.from ?? 42, first_name: 'Someone' },
      chat: { id: -100, type: over.chat ?? 'private' },
      text,
      ...(over.reply
        ? {
            reply_to_message: {
              message_id: 9,
              date: 1_799_999_000,
              chat: { id: -100, type: over.chat ?? 'private' },
              ...(over.reply.from === undefined ? {} : { from: { id: over.reply.from, first_name: 'Them' } }),
              ...(over.reply.text === undefined ? {} : { text: over.reply.text }),
            },
          }
        : {}),
    },
  };
}

async function run(u: Update): Promise<FakeTelegram> {
  const telegram = new FakeTelegram();
  const { HANDLERS } = await import('../handlers');
  await route(u, telegram, HANDLERS);
  return telegram;
}

beforeEach(() => {
  links.clear();
  checked.length = 0;
});

describe('/verify picks the right wallet', () => {
  it('takes the one typed after it', async () => {
    await run(update(`/verify ${WALLET}`));
    expect(checked).toEqual([WALLET]);
  });

  it('works in a group, addressed to the bot by name', async () => {
    await run(update(`/verify@probatio_bot ${WALLET}`, { chat: 'group' }));
    expect(checked).toEqual([WALLET]);
  });

  /*
   * The one that settles arguments. Somebody posts a claim with an address in
   * it, somebody else replies with six characters.
   */
  it('takes an address out of the message it is replying to', async () => {
    await run(update('/verify', { chat: 'group', reply: { text: `up 40x on ${WALLET} today` } }));
    expect(checked).toEqual([WALLET]);
  });

  it('falls back to the linked account of whoever it is replying to', async () => {
    links.set(77, OTHER);
    await run(update('/verify', { chat: 'group', reply: { text: 'no address here', from: 77 } }));
    expect(checked).toEqual([OTHER]);
  });

  /*
   * An address in the message beats the sender's linked account. They are
   * making a claim about that address, and it need not be one of theirs.
   */
  it('prefers the address in the message over the sender it belongs to', async () => {
    links.set(77, OTHER);
    await run(update('/verify', { chat: 'group', reply: { text: WALLET, from: 77 } }));
    expect(checked).toEqual([WALLET]);
  });

  it('checks your own when you ask for nothing in a direct message', async () => {
    links.set(42, WALLET);
    await run(update('/verify'));
    expect(checked).toEqual([WALLET]);
  });

  /*
   * Never guess. A bare /verify in a group with nothing to go on has to ask,
   * not quietly check whoever happened to send it.
   */
  it('asks rather than guessing when there is nothing to go on', async () => {
    links.set(42, OTHER);
    const telegram = await run(update('/verify', { chat: 'group' }));
    expect(checked).toEqual([]);
    expect(telegram.sent[0]?.text).toContain('Give me a wallet');
  });

  it('refuses a wallet that is not one rather than looking it up', async () => {
    await run(update('/verify probably-not-a-wallet'));
    expect(checked).toEqual([]);
  });
});

describe('inline mode', () => {
  it('answers a wallet typed in a chat the bot was never added to', async () => {
    const telegram = new FakeTelegram();
    const { HANDLERS } = await import('../handlers');
    await route({ update_id: 2, inline_query: { id: 'q1', from: { id: 42, first_name: 'Someone' }, query: `${WALLET} `, offset: '' } }, telegram, HANDLERS);

    expect(checked).toEqual([WALLET]);
    const answer = telegram.inline[0];
    expect(answer?.results[0]?.id).toBe(`verify:${WALLET}`);
    // Never cached: the answer is a claim about a record that can change, and
    // Telegram will serve a stale one to the next person if allowed to.
    expect(answer?.cache_time).toBe(0);
  });

  it('offers help rather than an empty result when nothing was typed yet', async () => {
    const telegram = new FakeTelegram();
    const { HANDLERS } = await import('../handlers');
    await route({ update_id: 3, inline_query: { id: 'q2', from: { id: 42, first_name: 'Someone' }, query: '', offset: '' } }, telegram, HANDLERS);

    expect(checked).toEqual([]);
    expect(telegram.inline[0]?.results[0]?.id).toBe('help');
  });
});
