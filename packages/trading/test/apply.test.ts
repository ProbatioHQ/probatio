import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, type Quote } from '@probatio/sim';
import {
  TradingError,
  applyFill,
  emptyPosition,
  fractionOfPosition,
  sellableTokens,
  unrealizedPnl,
  type AccountState,
} from '../src/apply';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const PRICE_SCALE = 10n ** 18n;

function buy(solAmount: bigint, tokenAmount: bigint, feeLamports = 0n): Quote {
  return {
    side: 'buy',
    solAmount,
    tokenAmount,
    feeLamports,
    priceImpactBps: 0,
    partial: false,
    engineVersion: ENGINE_VERSION,
  };
}

function sell(tokenAmount: bigint, solAmount: bigint, feeLamports = 0n): Quote {
  return {
    side: 'sell',
    solAmount,
    tokenAmount,
    feeLamports,
    priceImpactBps: 0,
    partial: false,
    engineVersion: ENGINE_VERSION,
  };
}

const fresh: AccountState = { solBalance: 10_000_000_000n, position: null };

describe('buying', () => {
  it('spends SOL and opens a position', () => {
    const result = applyFill(fresh, buy(1_000_000_000n, 500n), MINT);

    expect(result.account.solBalance).toBe(9_000_000_000n);
    expect(result.account.position!.tokenAmount).toBe(500n);
    expect(result.account.position!.costBasis).toBe(1_000_000_000n);
    expect(result.realized).toBe(0n);
  });

  it('counts the fee as part of what the position cost', () => {
    // A position is only in profit once it has covered what it cost to open.
    // Excluding the fee would report a win on a trade that lost money.
    const result = applyFill(fresh, buy(1_000_000_000n, 500n, 12_500_000n), MINT);
    expect(result.account.position!.costBasis).toBe(1_000_000_000n);
  });

  it('adds to an existing position', () => {
    const first = applyFill(fresh, buy(1_000_000_000n, 500n), MINT);
    const second = applyFill(first.account, buy(2_000_000_000n, 800n), MINT);

    expect(second.account.position!.tokenAmount).toBe(1_300n);
    expect(second.account.position!.costBasis).toBe(3_000_000_000n);
    expect(second.account.solBalance).toBe(7_000_000_000n);
  });

  it('refuses to spend more than the balance', () => {
    expect(() => applyFill(fresh, buy(20_000_000_000n, 1n), MINT)).toThrow(
      expect.objectContaining({ code: 'insufficient_sol' }),
    );
  });

  it('allows spending the entire balance', () => {
    const result = applyFill(fresh, buy(10_000_000_000n, 1n), MINT);
    expect(result.account.solBalance).toBe(0n);
  });

  it('refuses a position in a different token', () => {
    const held = applyFill(fresh, buy(1_000_000_000n, 500n), MINT);
    expect(() => applyFill(held.account, buy(1n, 1n), 'other')).toThrow(TradingError);
  });
});

describe('selling', () => {
  const held = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account;

  it('returns SOL and reduces the position', () => {
    const result = applyFill(held, sell(400n, 500_000_000n), MINT);

    expect(result.account.solBalance).toBe(9_000_000_000n + 500_000_000n);
    expect(result.account.position!.tokenAmount).toBe(600n);
  });

  it('realizes only a proportional slice of the basis', () => {
    // Selling 40% of a position books 40% of its cost. Booking the whole cost
    // would make every partial exit look like a disaster and every remainder
    // like a windfall.
    const result = applyFill(held, sell(400n, 500_000_000n), MINT);

    expect(result.realized).toBe(500_000_000n - 400_000_000n);
    expect(result.account.position!.costBasis).toBe(600_000_000n);
  });

  it('books a loss when it sells below cost', () => {
    const result = applyFill(held, sell(500n, 100_000_000n), MINT);
    expect(result.realized).toBe(100_000_000n - 500_000_000n);
    expect(result.realized).toBeLessThan(0n);
  });

  it('takes the whole basis when closing entirely', () => {
    const result = applyFill(held, sell(1_000n, 1_500_000_000n), MINT);

    expect(result.closed).toBe(true);
    expect(result.account.position!.tokenAmount).toBe(0n);
    expect(result.account.position!.costBasis).toBe(0n);
    expect(result.realized).toBe(500_000_000n);
  });

  it('leaves no phantom cost behind after a full exit', () => {
    // A lifetime of floored slices would otherwise leave a basis against a
    // position of zero tokens, which reads as a permanent unrealized loss.
    let state = applyFill(fresh, buy(1_000_000_007n, 3n), MINT).account;
    state = applyFill(state, sell(1n, 100n), MINT).account;
    state = applyFill(state, sell(1n, 100n), MINT).account;
    const last = applyFill(state, sell(1n, 100n), MINT);

    expect(last.account.position!.tokenAmount).toBe(0n);
    expect(last.account.position!.costBasis).toBe(0n);
  });

  it('accumulates realized PnL across sells', () => {
    const first = applyFill(held, sell(500n, 700_000_000n), MINT);
    const second = applyFill(first.account, sell(500n, 100_000_000n), MINT);

    expect(second.account.position!.realizedPnl).toBe(
      first.realized + second.realized,
    );
  });

  it('refuses to sell more than is held', () => {
    expect(() => applyFill(held, sell(2_000n, 1n), MINT)).toThrow(
      expect.objectContaining({ code: 'insufficient_tokens' }),
    );
  });

  it('refuses to sell a token with no position', () => {
    expect(() => applyFill(fresh, sell(1n, 1n), MINT)).toThrow(
      expect.objectContaining({ code: 'insufficient_tokens' }),
    );
  });

  it('rounds the disposed basis down, never up', () => {
    // Rounding the other way would book less cost than was actually incurred,
    // which is profit conjured out of division.
    const odd = applyFill(fresh, buy(1_000_000_001n, 3n), MINT).account;
    const result = applyFill(odd, sell(1n, 0n + 1n), MINT);

    expect(result.account.position!.costBasis).toBeGreaterThanOrEqual(666_666_667n);
  });
});

describe('a full round trip', () => {
  it('leaves the balance short by exactly what was lost', () => {
    const opened = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account;
    const closed = applyFill(opened, sell(1_000n, 900_000_000n), MINT);

    expect(closed.account.solBalance).toBe(9_900_000_000n);
    expect(closed.account.position!.realizedPnl).toBe(-100_000_000n);
  });

  it('conserves value when nothing moves', () => {
    const opened = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account;
    const closed = applyFill(opened, sell(1_000n, 1_000_000_000n), MINT);

    expect(closed.account.solBalance).toBe(fresh.solBalance);
    expect(closed.account.position!.realizedPnl).toBe(0n);
  });
});

describe('unrealizedPnl', () => {
  it('values a position at the current price', () => {
    const held = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account.position!;
    const { value, unrealized } = unrealizedPnl(held, 2_000_000n * PRICE_SCALE / 1_000_000n, PRICE_SCALE);

    expect(value).toBe(2_000n);
    expect(unrealized).toBe(2_000n - 1_000_000_000n);
  });

  it('is zero for an empty position', () => {
    const { value, unrealized } = unrealizedPnl(emptyPosition(MINT), PRICE_SCALE, PRICE_SCALE);
    expect(value).toBe(0n);
    expect(unrealized).toBe(0n);
  });
});

describe('helpers', () => {
  it('reports what can be sold', () => {
    const held = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account.position;
    expect(sellableTokens(held, MINT)).toBe(1_000n);
    expect(sellableTokens(held, 'other')).toBe(0n);
    expect(sellableTokens(null, MINT)).toBe(0n);
  });

  it('takes an exact fraction of a position', () => {
    const held = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account.position!;
    expect(fractionOfPosition(held, 1, 2)).toBe(500n);
    expect(fractionOfPosition(held, 1, 4)).toBe(250n);
  });

  it('returns the whole position rather than a rounded fraction of it', () => {
    // A "sell 100%" button must leave nothing behind, and a floored fraction
    // of an odd holding would strand a token.
    const held = applyFill(fresh, buy(1_000_000_000n, 999n), MINT).account.position!;
    expect(fractionOfPosition(held, 1, 1)).toBe(999n);
  });

  it('never exceeds the holding', () => {
    const held = applyFill(fresh, buy(1_000_000_000n, 7n), MINT).account.position!;
    expect(fractionOfPosition(held, 1, 3)).toBe(2n);
  });

  it('refuses a nonsensical fraction', () => {
    const held = applyFill(fresh, buy(1_000_000_000n, 1_000n), MINT).account.position!;
    expect(() => fractionOfPosition(held, 2, 1)).toThrow(TradingError);
    expect(() => fractionOfPosition(held, 1, 0)).toThrow(TradingError);
  });
});
