import { describe, expect, it } from 'vitest';
import { QuoteError, applyQuote, quoteBuy, quoteSell } from '../src/engine';
import { ENGINE_VERSION } from '../src/version';
import type { FeeSchedule, PoolState } from '../src/types';
import { totalFeeBps } from '../src/types';

/** The real bonding curve schedule: 0.95% protocol, 0.30% creator. */
const CURVE_FEES: FeeSchedule = { protocolBps: 95, creatorBps: 30, lpBps: 0 };
const NO_FEES: FeeSchedule = { protocolBps: 0, creatorBps: 0, lpBps: 0 };

function pool(overrides: Partial<PoolState> = {}): PoolState {
  return {
    mint: 'mint',
    solReserve: 31_000_000_000n,
    tokenReserve: 1_000_000_000_000_000n,
    deliverableTokens: 700_000_000_000_000n,
    tokenDecimals: 6,
    fees: CURVE_FEES,
    source: 'pumpfun-curve',
    slot: 1,
    ...overrides,
  };
}

describe('totalFeeBps', () => {
  it('sums the parts', () => {
    expect(totalFeeBps(CURVE_FEES)).toBe(125);
    expect(totalFeeBps({ protocolBps: 20, creatorBps: 5, lpBps: 5 })).toBe(30);
  });
});

describe('quoteBuy', () => {
  it('returns tokens for SOL', () => {
    const quote = quoteBuy(pool(), 1_000_000_000n);
    expect(quote.side).toBe('buy');
    expect(quote.tokenAmount).toBeGreaterThan(0n);
    expect(quote.solAmount).toBe(1_000_000_000n);
  });

  it('takes the fee off the input before the curve sees it', () => {
    const size = 1_000_000_000n;
    const withFee = quoteBuy(pool(), size);
    const withoutFee = quoteBuy(pool({ fees: NO_FEES }), size);

    // The fee is charged on the way in, so a fee-free pool hands over more
    // tokens for the same SOL.
    expect(withFee.tokenAmount).toBeLessThan(withoutFee.tokenAmount);
    expect(withFee.feeLamports).toBeGreaterThan(0n);

    // Exactly one lamport, even with no fee schedule at all. That is the
    // program's own `- 1` in the buy formula, reproduced faithfully — a real
    // fill loses it, so the engine has to as well.
    expect(withoutFee.feeLamports).toBe(1n);
  });

  it('charges close to the stated rate', () => {
    const size = 1_000_000_000n;
    const quote = quoteBuy(pool(), size);
    // 125bp of 1 SOL, within a lamport of rounding.
    const expected = (size * 125n) / 10_125n;
    expect(quote.feeLamports).toBeGreaterThanOrEqual(expected - 2n);
    expect(quote.feeLamports).toBeLessThanOrEqual(expected + 2n);
  });

  it('caps at what the curve can actually deliver', () => {
    // A curve prices against virtual reserves but only holds the real ones.
    const quote = quoteBuy(pool({ deliverableTokens: 1_000n }), 1_000_000_000_000n);
    expect(quote.tokenAmount).toBe(1_000n);
    expect(quote.partial).toBe(true);
  });

  it('is not partial when the curve can fill it', () => {
    expect(quoteBuy(pool(), 1_000_000n).partial).toBe(false);
  });

  it('moves the price against a larger buy', () => {
    const small = quoteBuy(pool(), 1_000_000n);
    const large = quoteBuy(pool(), 10_000_000_000n);
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
  });

  it('records the engine version', () => {
    expect(quoteBuy(pool(), 1_000_000n).engineVersion).toBe(ENGINE_VERSION);
  });

  it('rejects a non-positive size', () => {
    expect(() => quoteBuy(pool(), 0n)).toThrow(QuoteError);
    expect(() => quoteBuy(pool(), -1n)).toThrow(QuoteError);
  });

  it('rejects dust that buys nothing', () => {
    expect(() => quoteBuy(pool(), 1n)).toThrow(
      expect.objectContaining({ code: 'dust' }),
    );
  });

  it('rejects a pool with no liquidity at all', () => {
    expect(() => quoteBuy(pool({ deliverableTokens: 0n }), 1_000_000_000n)).toThrow(
      expect.objectContaining({ code: 'no_liquidity' }),
    );
  });

  it('rejects an empty reserve', () => {
    expect(() => quoteBuy(pool({ solReserve: 0n }), 1_000n)).toThrow(
      expect.objectContaining({ code: 'empty_reserves' }),
    );
  });
});

describe('quoteSell', () => {
  it('returns SOL for tokens', () => {
    const quote = quoteSell(pool(), 1_000_000_000n);
    expect(quote.side).toBe('sell');
    expect(quote.solAmount).toBeGreaterThan(0n);
    expect(quote.tokenAmount).toBe(1_000_000_000n);
  });

  it('takes the fee off the output, not the input', () => {
    const size = 1_000_000_000_000n;
    const withFee = quoteSell(pool(), size);
    const withoutFee = quoteSell(pool({ fees: NO_FEES }), size);

    // The gross proceeds are identical; only what reaches the trader differs.
    expect(withFee.solAmount + withFee.feeLamports).toBe(withoutFee.solAmount);
  });

  it('charges the stated rate on the gross', () => {
    const quote = quoteSell(pool(), 1_000_000_000_000n);
    const gross = quote.solAmount + quote.feeLamports;
    const expected = (gross * 125n + 9_999n) / 10_000n;
    expect(quote.feeLamports).toBe(expected);
  });

  it('rejects a non-positive size', () => {
    expect(() => quoteSell(pool(), 0n)).toThrow(QuoteError);
  });

  it('rejects dust that returns nothing', () => {
    expect(() => quoteSell(pool(), 1n)).toThrow(
      expect.objectContaining({ code: 'dust' }),
    );
  });
});

describe('rounding always favours the pool', () => {
  it('never lets a round trip profit at the pool’s expense', () => {
    // Buy then immediately sell the tokens back. With fees this must lose; the
    // point is that it can never win, which is how a leaderboard gets farmed.
    let state = pool();
    const buy = quoteBuy(state, 1_000_000_000n);
    state = applyQuote(state, buy);
    const sell = quoteSell(state, buy.tokenAmount);

    expect(sell.solAmount).toBeLessThan(buy.solAmount);
  });

  it('cannot be won even with no fees at all', () => {
    // The strongest form: strip the fees and the rounding alone must still
    // never hand a trader more than they put in.
    let state = pool({ fees: NO_FEES });
    for (const size of [1_000n, 1_000_000n, 1_000_000_000n, 10_000_000_000n]) {
      let s = state;
      const buy = quoteBuy(s, size);
      s = applyQuote(s, buy);
      const sell = quoteSell(s, buy.tokenAmount);
      expect(sell.solAmount).toBeLessThanOrEqual(size);
    }
    expect(state).toBeDefined();
  });
});

describe('applyQuote', () => {
  it('moves reserves the right way on a buy', () => {
    const before = pool();
    const quote = quoteBuy(before, 1_000_000_000n);
    const after = applyQuote(before, quote);

    expect(after.solReserve).toBeGreaterThan(before.solReserve);
    expect(after.tokenReserve).toBeLessThan(before.tokenReserve);
    expect(after.deliverableTokens).toBe(before.deliverableTokens - quote.tokenAmount);
  });

  it('moves reserves the right way on a sell', () => {
    const before = pool();
    const quote = quoteSell(before, 1_000_000_000_000n);
    const after = applyQuote(before, quote);

    expect(after.solReserve).toBeLessThan(before.solReserve);
    expect(after.tokenReserve).toBeGreaterThan(before.tokenReserve);
  });

  it('does not credit fees to the pool', () => {
    // Fees are paid out to the protocol and creator, not retained as
    // liquidity. Adding them to the reserve would break the constant product.
    const before = pool();
    const quote = quoteBuy(before, 1_000_000_000n);
    const after = applyQuote(before, quote);

    expect(after.solReserve).toBe(before.solReserve + quote.solAmount - quote.feeLamports);
  });

  it('lets a second quote follow the first', () => {
    let state = pool();
    const first = quoteBuy(state, 1_000_000_000n);
    state = applyQuote(state, first);
    const second = quoteBuy(state, 1_000_000_000n);

    // The price has moved, so the same SOL buys fewer tokens.
    expect(second.tokenAmount).toBeLessThan(first.tokenAmount);
  });
});
