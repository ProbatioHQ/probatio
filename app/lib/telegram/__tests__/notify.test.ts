import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTelegram } from '../transport';
import type { WatchedFill } from '@probatio/db';

/**
 * One delivery pass.
 *
 * The sending is not the interesting part. What is tested here is that a fill
 * cannot be delivered twice or lost: the cursor moves only for what was
 * actually said, and only when Telegram accepted it.
 */

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'So11111111111111111111111111111111111111112';

let owed: WatchedFill[] = [];
const advanced: [number, number][] = [];
const dropped: number[] = [];

vi.mock('../../db', () => ({ db: async () => ({}) }));
vi.mock('../../token-name', () => ({
  resolveTokenName: async () => ({ name: 'Wrapped SOL', symbol: 'SOL', known: true }),
}));
vi.mock('@probatio/db', () => ({
  pendingFills: async (_client: unknown, limit = 200) => owed.slice(0, limit),
  advanceWatch: async (_client: unknown, watchId: number, tradeId: number) => {
    advanced.push([watchId, tradeId]);
  },
  dropChat: async (_client: unknown, chatId: number) => {
    dropped.push(chatId);
    return 1;
  },
}));

function owedFill(over: Partial<WatchedFill> = {}): WatchedFill {
  return {
    watchId: 1,
    chatId: -100,
    trader: A,
    tradeId: 1,
    mint: MINT,
    side: 'buy',
    solAmount: '1000000000',
    tokenAmount: '1000000',
    priceImpactBps: 40,
    partial: false,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  owed = [];
  advanced.length = 0;
  dropped.length = 0;
});

describe('delivering', () => {
  it('says nothing when nothing is owed', async () => {
    const telegram = new FakeTelegram();
    const { deliverWatches } = await import('../notify');
    expect(await deliverWatches(telegram)).toBe(0);
    expect(telegram.sent).toEqual([]);
  });

  /*
   * One message per chat, not one per fill. Telegram takes twenty messages a
   * minute to a group and a trader on a tear produces more than that.
   */
  it('gathers a chat’s fills into one message', async () => {
    owed = [
      owedFill({ tradeId: 1 }),
      owedFill({ tradeId: 2, side: 'sell' }),
      owedFill({ tradeId: 3, watchId: 2, trader: B }),
    ];
    const telegram = new FakeTelegram();
    const { deliverWatches } = await import('../notify');

    expect(await deliverWatches(telegram)).toBe(1);
    expect(telegram.sent).toHaveLength(1);
    const text = telegram.last() ?? '';
    expect(text).toContain('bought SOL for <b>1 SOL</b>');
    expect(text).toContain('sold SOL for <b>1 SOL</b>');
    // Grouped under the trader they belong to, or two traders' fills read as
    // one person's run.
    expect(text).toContain(A.slice(0, 4));
    expect(text).toContain(B.slice(0, 4));
  });

  it('advances each watch to the newest fill it was told about', async () => {
    owed = [
      owedFill({ watchId: 1, tradeId: 1 }),
      owedFill({ watchId: 1, tradeId: 4 }),
      owedFill({ watchId: 2, trader: B, tradeId: 3 }),
    ];
    const { deliverWatches } = await import('../notify');
    await deliverWatches(new FakeTelegram());

    expect(advanced.sort()).toEqual([[1, 4], [2, 3]]);
  });

  it('keeps two chats apart', async () => {
    owed = [owedFill({ chatId: -100 }), owedFill({ chatId: -200, watchId: 2, tradeId: 2 })];
    const telegram = new FakeTelegram();
    const { deliverWatches } = await import('../notify');

    expect(await deliverWatches(telegram)).toBe(2);
    expect(telegram.sent.map((message) => message.chat_id).sort((l, r) => l - r)).toEqual([-200, -100]);
  });

  /*
   * A failed send leaves every cursor where it was, so the next pass owes the
   * same fills and tries again. Advancing regardless would turn one bad minute
   * of Telegram's into fills nobody was ever told about.
   */
  it('marks nothing delivered that was not', async () => {
    owed = [owedFill()];
    const telegram = new FakeTelegram();
    telegram.refusing.add(-100);
    const { deliverWatches } = await import('../notify');

    expect(await deliverWatches(telegram)).toBe(0);
    expect(advanced).toEqual([]);
    expect(dropped).toEqual([]);
  });

  /*
   * Blocked or removed is permanent, and a watch delivering into a chat that
   * will never take another message is a failing request every twenty seconds
   * for ever. Only that case tears anything down: a rate limit must not.
   */
  it('drops a chat that is gone, and only one that is gone', async () => {
    owed = [owedFill()];
    const telegram = new FakeTelegram();
    telegram.refusing.add(-100);
    telegram.gone.add(-100);
    const { deliverWatches } = await import('../notify');

    await deliverWatches(telegram);
    expect(dropped).toEqual([-100]);
    expect(advanced).toEqual([]);
  });

  /*
   * A long batch says how many more there were rather than growing without
   * limit, and crucially does not advance past what it actually said.
   */
  it('does not claim to have delivered what it truncated', async () => {
    owed = Array.from({ length: 20 }, (_, index) => owedFill({ tradeId: index + 1 }));
    const telegram = new FakeTelegram();
    const { deliverWatches } = await import('../notify');

    await deliverWatches(telegram);
    expect(telegram.last()).toContain('more');
    expect(advanced).toEqual([[1, 12]]);
  });
});
