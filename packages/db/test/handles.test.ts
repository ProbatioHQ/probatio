import { describe, expect, it } from 'vitest';
import { twitterHandle } from '../src/handles';

/**
 * Reducing an X link to the account behind it.
 *
 * The whole "is this account on eleven other tokens" condition rests on this
 * one function. Group the raw URLs instead and every spelling counts as a
 * different account, which turns one serial promoter into eleven first-timers:
 * the signal inverted, reported confidently.
 */

describe('the account out of an X link', () => {
  it('reads the same account however it was written', () => {
    for (const url of [
      'https://x.com/probatiohq',
      'https://X.com/ProbatioHQ',
      'https://www.x.com/probatiohq',
      'https://twitter.com/probatiohq',
      'https://mobile.twitter.com/probatiohq',
      'https://x.com/probatiohq/',
      'https://x.com/probatiohq?s=21',
      '  https://x.com/ProbatioHQ  ',
    ]) {
      expect(twitterHandle(url)).toBe('probatiohq');
    }
  });

  /*
   * A link to one post is not an account. Plenty of tokens point their
   * "twitter" at a single message in somebody else's thread, and crediting the
   * token with that stranger's history is worse than knowing nothing.
   */
  it('refuses a link to a single post', () => {
    expect(twitterHandle('https://x.com/someone/status/1925570414702669955')).toBeNull();
    expect(twitterHandle('https://twitter.com/someone/statuses/123')).toBeNull();
  });

  it('refuses the parts of the site that are not accounts', () => {
    expect(twitterHandle('https://x.com/search?q=probatio')).toBeNull();
    expect(twitterHandle('https://x.com/hashtag/solana')).toBeNull();
    expect(twitterHandle('https://x.com/i/communities/123')).toBeNull();
    expect(twitterHandle('https://x.com/')).toBeNull();
  });

  it('refuses anything that is not X at all', () => {
    // A telegram link in the twitter field is a launcher filling the form in
    // badly, not an account.
    expect(twitterHandle('https://t.me/probatio')).toBeNull();
    expect(twitterHandle('https://x.com.evil.example/probatiohq')).toBeNull();
    expect(twitterHandle('not a url')).toBeNull();
    expect(twitterHandle('')).toBeNull();
    expect(twitterHandle(null)).toBeNull();
  });

  it('refuses a handle that could not be one', () => {
    // X handles are at most fifteen characters of letters, digits and
    // underscores. Anything else is a path this does not understand.
    expect(twitterHandle('https://x.com/waaaaaaaaaaaaaaaaaaytoolong')).toBeNull();
    expect(twitterHandle('https://x.com/has-a-dash')).toBeNull();
  });
});
