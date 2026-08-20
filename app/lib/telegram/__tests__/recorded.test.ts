import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeTelegram } from '../transport';
import { route } from '../router';
import type { Update } from '../types';

/**
 * The awkward shapes, replayed.
 *
 * These payloads exist so the harness can drive the cases that are tedious to
 * construct by hand and easy to get subtly wrong: a reply in a group, an inline
 * query from a chat the bot was never added to, a tap from somebody the card
 * does not belong to.
 *
 * They are checked here as well as driven there, because a recording nobody
 * verifies rots. A handler rename, a changed callback format, a command that
 * stops being registered — each would leave the fixtures silently producing
 * nothing, and the harness would look like it was working.
 */

const UPDATES = fileURLToPath(new URL('../../../../scripts/telegram/updates', import.meta.url));

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
  watchTrader: async () => 'added',
  unwatchTrader: async () => true,
  watchesFor: async () => [],
}));
vi.mock('../verify', async (original) => ({
  ...(await original<typeof import('../verify')>()),
  verifyWallet: async (trader: string) => ({ trader, record: null, empty: true, unreachable: false }),
}));

function load(): { name: string; update: Update }[] {
  return readdirSync(UPDATES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name: name.replace(/\.json$/, ''),
      update: JSON.parse(readFileSync(`${UPDATES}/${name}`, 'utf8')) as Update,
    }));
}

async function play(update: Update): Promise<FakeTelegram> {
  const telegram = new FakeTelegram();
  const { HANDLERS } = await import('../handlers');
  await route(update, telegram, HANDLERS);
  return telegram;
}

const recorded = load();
const byName = new Map(recorded.map((one) => [one.name, one.update]));

function named(name: string): Update {
  const update = byName.get(name);
  if (!update) throw new Error(`no recorded update called ${name}`);
  return update;
}

beforeEach(() => vi.clearAllMocks());

describe('the recorded updates', () => {
  it('are all payloads Telegram could actually send', () => {
    expect(recorded.length).toBeGreaterThan(0);
    for (const { name, update } of recorded) {
      expect(typeof update.update_id, name).toBe('number');
      const kinds = [update.message, update.callback_query, update.inline_query].filter(Boolean);
      expect(kinds, name).toHaveLength(1);
    }
  });

  /*
   * The one that catches rot. A renamed handler or a changed callback format
   * would leave these producing nothing at all, and the harness would look like
   * it was working.
   */
  it('each still make the bot say something', async () => {
    for (const { name, update } of recorded) {
      const telegram = await play(update);
      const said = telegram.sent.length + telegram.answered.length + telegram.inline.length;
      // Except the one whose whole point is silence, below.
      if (name.includes('unknown-in-a-group')) expect(said, name).toBe(0);
      else expect(said, name).toBeGreaterThan(0);
    }
  });
});

describe('what each awkward shape is for', () => {
  /*
   * Telegram writes the @botname suffix in any group where more than one bot
   * might be listening. Without stripping it, every command in every group
   * silently does nothing.
   */
  it('answers a command addressed to it by name', async () => {
    expect((await play(named('01-help-in-a-group'))).last()).toContain('/verify');
  });

  it('takes a wallet out of the message it replies to', async () => {
    expect((await play(named('03-verify-a-reply'))).last()).toContain('no record');
  });

  it('asks rather than guessing when given nothing', async () => {
    expect((await play(named('04-verify-with-nothing'))).last()).toContain('Give me a wallet');
  });

  it('answers an inline query from a chat it was never added to', async () => {
    const telegram = await play(named('05-inline-query'));
    expect(telegram.inline[0]?.cache_time).toBe(0);
    expect(telegram.sent).toEqual([]);
  });

  /*
   * A link code is a bearer token for an account, and posting one into a room
   * hands it to the room.
   */
  it('refuses to hand a link code to a group', async () => {
    expect((await play(named('07-link-in-a-group'))).last()).toContain('directly');
  });

  it('offers sizes rather than choosing one', async () => {
    const telegram = await play(named('09-buy-without-a-size'));
    // No account is linked in these mocks, so it asks for one first. Either way
    // it must not have placed anything.
    expect(telegram.last()).toContain('/link');
  });

  /*
   * The one that matters most in a group. Anybody can tap anybody's buttons,
   * and without the owner in the payload a stranger's tap places a real fill on
   * somebody else's public record.
   */
  it('refuses a stranger’s tap with an alert, and sends nothing', async () => {
    const telegram = await play(named('10-a-stranger-taps'));
    expect(telegram.answered[0]?.show_alert).toBe(true);
    expect(telegram.sent).toEqual([]);
  });

  /*
   * In a group an unknown command is almost always another bot being addressed,
   * and a room full of bots announcing they did not understand is why people
   * remove bots.
   */
  it('stays quiet when a group addresses something else', async () => {
    const telegram = await play(named('12-unknown-in-a-group'));
    expect(telegram.sent).toEqual([]);
  });
});

/**
 * The menu Telegram shows, against the commands that exist.
 *
 * Two lists of the same commands that disagree is worse than one list: a menu
 * entry with no handler is a command the bot offers and then does not know,
 * and a handler with no menu entry is a feature nobody discovers. Neither
 * errors, and neither is visible without going looking.
 */
describe('the command menu', () => {
  const setup = readFileSync(
    fileURLToPath(new URL('../../../../scripts/telegram-setup.mts', import.meta.url)),
    'utf8',
  );

  it('offers exactly the commands the bot handles', async () => {
    const { HANDLERS } = await import('../handlers');
    const menu = [...setup.matchAll(/\{ command: '(\w+)'/g)].map((match) => match[1]);

    expect(menu.length).toBeGreaterThan(0);
    expect([...menu].sort()).toEqual(Object.keys(HANDLERS.commands).sort());
  });

  /*
   * Telegram renders these in a cramped row under the input box, and rejects a
   * description longer than its limit outright — which would fail the whole
   * menu, not just the entry.
   */
  it('describes each one in something that fits', () => {
    for (const [, description] of setup.matchAll(/description: '([^']+)'/g)) {
      expect(description!.length).toBeLessThanOrEqual(64);
    }
  });
});
