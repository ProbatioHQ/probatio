import { describe, expect, it } from 'vitest';
import { parseCommand } from '../router';

/**
 * The one rule about /link that is not in the database.
 *
 * A link code is a bearer token for an account: whoever holds it can attach
 * their Telegram to it. Posting one into a group hands it to the room, so the
 * command refuses to issue one anywhere except a direct message. The refusal
 * has to be a reply rather than silence, or somebody stands there wondering
 * whether the bot heard them.
 */
describe('/link is a direct message command', () => {
  it('is recognised however Telegram writes it in a group', () => {
    expect(parseCommand('/link@probatio_bot')).toEqual({ name: 'link', args: '' });
    expect(parseCommand('/unlink')).toEqual({ name: 'unlink', args: '' });
  });
});
