import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, simulateFill, type ExecutionRules } from '../src/execution';
import { applyQuote, quoteBuy } from '../src/engine';
import type { FeeSchedule, PoolState } from '../src/types';

const CURVE_FEES: FeeSchedule = { protocolBps: 95, creatorBps: 30, lpBps: 0 };

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

function rules(overrides: Partial<ExecutionRules> = {}): ExecutionRules {
  return { ...DEFAULT_RULES, ...overrides };
}

/** Move the price by pushing a buy through the pool. */
function afterBuyOf(state: PoolState, size: bigint): PoolState {
  return applyQuote(state, quoteBuy(state, size));
}

describe('a quiet market', () => {
  it('fills at the quoted amount when nothing moved', () => {
    const state = pool();
    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules(),
    });

    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.slippageBps).toBe(0);
    expect(outcome.quote.tokenAmount).toBe(outcome.expected.tokenAmount);
  });

  it('records the latency it was filled under', () => {
    const state = pool();
    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules({ latencyMs: 750 }),
    });

    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.latencyMs).toBe(750);
  });
});

describe('the price moving in flight', () => {
  it('fills for less when someone bought ahead of you', () => {
    const atClick = pool();
    // A modest front-run: enough to move the price, not enough to breach the
    // default tolerance. Anything larger is the rejection case below.
    const atFill = afterBuyOf(atClick, 500_000_000n);

    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick,
      atFill,
      rules: rules(),
    });

    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.quote.tokenAmount).toBeLessThan(outcome.expected.tokenAmount);
    expect(outcome.slippageBps).toBeGreaterThan(0);
  });

  it('rejects when the move exceeds the tolerance', () => {
    // The thing that makes this honest. Real trades fail like this constantly,
    // and a simulator where every click succeeds hands out records that look
    // like skill and are really just the absence of friction.
    const atClick = pool();
    const atFill = afterBuyOf(atClick, 20_000_000_000n);

    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick,
      atFill,
      rules: rules({ slippageBps: 100 }),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('slippage');
    expect(outcome.detail).toMatch(/moved/);
  });

  it('reports negative slippage when the price moved your way', () => {
    const atClick = afterBuyOf(pool(), 5_000_000_000n);
    const atFill = pool();

    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick,
      atFill,
      rules: rules(),
    });

    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    // Waiting sometimes helps, and a favourable move must never be treated as
    // a breach of tolerance.
    expect(outcome.slippageBps).toBeLessThan(0);
  });

  it('never rejects a favourable move however large', () => {
    const atClick = afterBuyOf(pool(), 20_000_000_000n);
    const atFill = pool();

    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000n,
      atClick,
      atFill,
      rules: rules({ slippageBps: 1 }),
    });

    expect(outcome.status).toBe('filled');
  });
});

describe('price impact', () => {
  it('refuses a size that would move the market too far', () => {
    const state = pool();
    const outcome = simulateFill({
      side: 'buy',
      size: 500_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules({ maxPriceImpactBps: 500 }),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('price_impact');
  });

  it('allows the same size when the cap is higher', () => {
    const state = pool();
    const outcome = simulateFill({
      side: 'buy',
      size: 500_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules({ maxPriceImpactBps: 50_000, slippageBps: 50_000 }),
    });

    expect(outcome.status).toBe('filled');
  });

  it('re-checks impact against the pool that actually filled it', () => {
    // A size that was reasonable on click can be reckless by the time it
    // lands, because the pool it hits is thinner than the one it was measured
    // against.
    const atClick = pool();
    const atFill = pool({ solReserve: 3_100_000_000n, tokenReserve: 100_000_000_000_000n });

    const outcome = simulateFill({
      side: 'buy',
      size: 2_000_000_000n,
      atClick,
      atFill,
      rules: rules({ maxPriceImpactBps: 700, slippageBps: 100_000 }),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('price_impact');
    expect(outcome.detail).toMatch(/landed/);
  });
});

describe('thin depth', () => {
  it('fills partially when the venue cannot deliver it all', () => {
    const state = pool({ deliverableTokens: 1_000_000n });
    const outcome = simulateFill({
      side: 'buy',
      size: 5_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules({ allowPartialFills: true, maxPriceImpactBps: 100_000 }),
    });

    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.quote.partial).toBe(true);
    expect(outcome.quote.tokenAmount).toBe(1_000_000n);
  });

  it('refuses a partial fill when the rules forbid one', () => {
    const state = pool({ deliverableTokens: 1_000_000n });
    const outcome = simulateFill({
      side: 'buy',
      size: 5_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules({ allowPartialFills: false, maxPriceImpactBps: 100_000 }),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('partial_not_allowed');
  });

  it('reports no liquidity when the venue has nothing left', () => {
    const state = pool({ deliverableTokens: 0n });
    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick: state,
      atFill: state,
      rules: rules(),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('no_liquidity');
  });

  it('reports dust rather than pretending to fill it', () => {
    const state = pool();
    const outcome = simulateFill({
      side: 'buy',
      size: 1n,
      atClick: state,
      atFill: state,
      rules: rules(),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('dust');
  });

  it('fails a trade that became unfillable in flight', () => {
    const atClick = pool();
    const atFill = pool({ deliverableTokens: 0n });

    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick,
      atFill,
      rules: rules(),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('no_liquidity');
    expect(outcome.detail).toMatch(/on click but not on landing/);
  });
});

describe('graduation mid-trade', () => {
  it('fails rather than executing somewhere else', () => {
    // A real transaction aimed at the bonding curve fails when the token
    // migrates. Quietly routing it to the AMM instead would fill the trader at
    // a venue they never agreed to.
    const outcome = simulateFill({
      side: 'buy',
      size: 1_000_000_000n,
      atClick: pool({ source: 'pumpfun-curve' }),
      atFill: pool({ source: 'pumpswap' }),
      rules: rules(),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('venue_changed');
  });
});

describe('sells', () => {
  it('fills and measures slippage on the SOL received', () => {
    const atClick = pool();
    const atFill = pool({ solReserve: 30_000_000_000n });

    const outcome = simulateFill({
      side: 'sell',
      size: 1_000_000_000_000n,
      atClick,
      atFill,
      rules: rules(),
    });

    expect(outcome.status).toBe('filled');
    if (outcome.status !== 'filled') return;
    expect(outcome.quote.solAmount).toBeLessThan(outcome.expected.solAmount);
    expect(outcome.slippageBps).toBeGreaterThan(0);
  });

  it('rejects a sell that slipped too far', () => {
    const atClick = pool();
    const atFill = pool({ solReserve: 15_000_000_000n });

    const outcome = simulateFill({
      side: 'sell',
      size: 1_000_000_000_000n,
      atClick,
      atFill,
      rules: rules({ slippageBps: 100 }),
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') return;
    expect(outcome.reason).toBe('slippage');
  });
});

describe('determinism', () => {
  it('gives the same answer every time', () => {
    // No clock, no randomness. A leaderboard has to be recomputable by anyone,
    // and a random latency component would make every record unverifiable and
    // every loss arguable.
    const request = {
      side: 'buy' as const,
      size: 1_000_000_000n,
      atClick: pool(),
      atFill: afterBuyOf(pool(), 1_000_000_000n),
      rules: rules(),
    };

    const first = simulateFill(request);
    for (let i = 0; i < 20; i += 1) {
      expect(simulateFill(request)).toEqual(first);
    }
  });
});
