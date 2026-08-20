import { describe, expect, it } from 'vitest';
import { FakeTelegram } from '../transport';
import { parseCommand, route, type Handlers } from '../router';
import type { Update } from '../types';

/**
 * The bot, before there is a bot.
 *
 * None of this needs a token, a webhook or a chat, which was the reason for
 * putting the transport behind an interface in the first place. Every command
 * that follows gets tested the same way: drive the router with the update
 * Telegram would have sent and read what the bot would have said.
 */

function message(text: string, chatType: 'private' | 'group' = 'private'): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1_800_000_000,
      from: { id: 42, first_name: 'Someone' },
      chat: { id: -100, type: chatType },
      text,
    },
  };
}

const seen: string[] = [];
const HANDLERS: Handlers = {
  commands: {
    ping: async (context, command) => {
      seen.push(`ping:${command.args}`);
      await context.telegram.sendMessage({ chat_id: context.chatId, text: 'pong' });
    },
  },
  callbacks: {
    buy: async (context, data) => {
      seen.push(`buy:${data}`);
      await context.telegram.sendMessage({ chat_id: context.chatId, text: 'bought' });
    },
  },
};

describe('reading a command out of a message', () => {
  /*
   * Telegram writes `/verify@probatio_bot` in a group, because several bots may
   * be listening and the suffix is how one is addressed. Without stripping it,
   * every command in every group silently does nothing.
   */
  it('strips the bot it was addressed to', () => {
    expect(parseCommand('/verify@probatio_bot 4kjr')).toEqual({ name: 'verify', args: '4kjr' });
    expect(parseCommand('/VERIFY')).toEqual({ name: 'verify', args: '' });
  });

  it('takes everything after the command as its argument', () => {
    expect(parseCommand('/buy  9cRC  0.5 ')).toEqual({ name: 'buy', args: '9cRC  0.5' });
  });

  /* Somebody talking about the bot is not talking to it. */
  it('is not a command unless it starts the message', () => {
    expect(parseCommand('look at /verify')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});

describe('routing an update', () => {
  it('runs the command and replies to the chat it came from', async () => {
    const bot = new FakeTelegram();
    await route(message('/ping hello'), bot, HANDLERS);

    expect(seen).toContain('ping:hello');
    expect(bot.sent[0]).toMatchObject({ chat_id: -100, text: 'pong' });
  });

  /*
   * A room full of bots each announcing they did not understand is why people
   * remove bots. In a group an unknown command is almost always another bot
   * being addressed.
   */
  it('answers an unknown command privately and says nothing in a group', async () => {
    const direct = new FakeTelegram();
    await route(message('/nope', 'private'), direct, HANDLERS);
    expect(direct.last()).toContain('/nope');

    const group = new FakeTelegram();
    await route(message('/nope', 'group'), group, HANDLERS);
    expect(group.sent).toHaveLength(0);
  });

  it('sends a tap to the handler named by the data before the colon', async () => {
    const bot = new FakeTelegram();
    await route(
      {
        update_id: 2,
        callback_query: {
          id: 'q1',
          from: { id: 42 },
          data: 'buy:9cRC:500000000',
          message: { message_id: 11, date: 1, chat: { id: -100, type: 'private' } },
        },
      },
      bot,
      HANDLERS,
    );

    expect(seen).toContain('buy:buy:9cRC:500000000');
    expect(bot.last()).toBe('bought');
  });

  /*
   * An unanswered callback leaves the button spinning on somebody's phone until
   * Telegram times it out, so every tap is answered even when nothing handles it.
   */
  it('always answers a tap it has no handler for', async () => {
    const bot = new FakeTelegram();
    await route(
      {
        update_id: 3,
        callback_query: {
          id: 'q2',
          from: { id: 42 },
          data: 'unknown:thing',
          message: { message_id: 11, date: 1, chat: { id: -100, type: 'private' } },
        },
      },
      bot,
      HANDLERS,
    );

    expect(bot.answered).toEqual([{ callback_query_id: 'q2' }]);
  });

  /*
   * The one rule the webhook depends on. A router that throws is an update
   * Telegram retries, and a retried update is a second trade, so a broken
   * command must never become a duplicate of a working one.
   */
  it('never throws, whatever the handler does', async () => {
    const bot = new FakeTelegram();
    const explode: Handlers = {
      commands: {
        boom: async () => {
          throw new Error('handler exploded');
        },
      },
      callbacks: {},
    };

    await expect(route(message('/boom'), bot, explode)).resolves.toBeUndefined();
  });

  it('ignores an update with nothing in it', async () => {
    const bot = new FakeTelegram();
    await route({ update_id: 4 }, bot, HANDLERS);
    expect(bot.sent).toHaveLength(0);
  });
});
