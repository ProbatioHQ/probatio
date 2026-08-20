import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedRecord } from '@probatio/sdk';
import { findWallet, looksLikeWallet } from '../verify';
import { verifyCard, verdictLine } from '../cards';

/**
 * The command the bot exists for, tested without a token or a network.
 *
 * Two things are worth checking separately here. Pulling a wallet out of what
 * somebody typed, which is where a chat is messy, and what the card says once
 * the arithmetic is done, which is where an overstated claim would live.
 */

const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

describe('finding a wallet in what somebody typed', () => {
  it('takes a bare address', () => {
    expect(looksLikeWallet(WALLET)).toBe(true);
    expect(findWallet(WALLET)).toBe(WALLET);
  });

  /*
   * The realistic case. Somebody posts a sentence with an address in it and
   * replies to it with /verify: the address has to come out of the prose,
   * usually with punctuation stuck to the end of it.
   */
  it('takes one out of a sentence, punctuation and all', () => {
    expect(findWallet(`up 400% today, ${WALLET}.`)).toBe(WALLET);
    expect(findWallet(`check (${WALLET})`)).toBe(WALLET);
  });

  it('refuses things that only look address shaped', () => {
    expect(findWallet('probably not')).toBeNull();
    expect(findWallet(undefined)).toBeNull();
    // Base58 has no 0, O, I or l, which is most of what a typo hits.
    expect(looksLikeWallet('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJ0sgAsU')).toBe(false);
    // A transaction signature is longer than any wallet.
    expect(looksLikeWallet(`${WALLET}${WALLET}`)).toBe(false);
  });
});

function record(over: Partial<VerifiedRecord> = {}): VerifiedRecord {
  return {
    trader: WALLET,
    seasonOrdinal: 0,
    verified: true,
    root: 'ab'.repeat(32),
    broken: [],
    tradeCount: 12,
    checks: [],
    ...over,
  };
}

describe('what the card says', () => {
  it('states what was recomputed, and prints the root', () => {
    const text = verifyCard({ trader: WALLET, record: record(), empty: false, unreachable: false });
    expect(text).toContain('verifies');
    expect(text).toContain('12 sealed fills');
    expect(text).toContain('<code>abababababababab');
    expect(text).toContain(WALLET);
  });

  /*
   * The one that has to be unambiguous. A record that fails is the whole reason
   * a check is worth having, and the card should say so plainly rather than
   * softening it into something a screenshot can misread.
   */
  it('says plainly when a record does not verify', () => {
    const text = verifyCard({
      trader: WALLET,
      record: record({ verified: false, broken: ['3', '9'] }),
      empty: false,
      unreachable: false,
    });
    expect(text).toContain('does not verify');
    expect(text).toContain('2 of 12');
    expect(verdictLine({ trader: WALLET, record: record({ verified: false, broken: ['3'] }), empty: false, unreachable: false }))
      .toContain('Does not verify');
  });

  /*
   * Never let the bot's own failure read as a verdict on somebody's record.
   * "Could not reach it" and "it does not verify" are opposite claims and the
   * difference is the bot's credibility.
   */
  it('separates the bot failing from the record failing', () => {
    const text = verifyCard({ trader: WALLET, record: null, empty: false, unreachable: true });
    expect(text).toContain('Could not read');
    expect(text).not.toContain('does not verify');

    const none = verifyCard({ trader: WALLET, record: null, empty: true, unreachable: false });
    expect(none).toContain('no record');
    expect(none).not.toContain('does not verify');
  });
});

describe('reading the record', () => {
  beforeEach(() => void vi.restoreAllMocks());

  it('calls the same public endpoint anybody else would', async () => {
    const fetcher = vi.fn(async (url: string) => { void url; return new Response(JSON.stringify({ record: [] }), { status: 200 }); });
    vi.stubGlobal('fetch', fetcher);
    const { verifyWallet } = await import('../verify');

    const result = await verifyWallet(WALLET);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`/api/proof?trader=${WALLET}`);
    expect(result.empty).toBe(true);
    expect(result.unreachable).toBe(false);
  });

  it('reports a dead endpoint as unreachable, not as a failed record', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { verifyWallet } = await import('../verify');

    const result = await verifyWallet(WALLET);
    expect(result.unreachable).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.record).toBeNull();
  });
});
