import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION, applyQuote, quoteBuy, quoteSell, type PoolState } from '@probatio/sim';
import { PUMPFUN_CURVE_FEES, type TradeEvent } from '@probatio/pools';
import { combine, isConsecutive, replay, type OrderedEvent } from '../src/replay';
import { formatReport } from '../src/format';

const MINT = 'mint';

const START: PoolState = {
  mint: MINT,
  solReserve: 31_000_000_000n,
  tokenReserve: 1_000_000_000_000_000n,
  deliverableTokens: 700_000_000_000_000n,
  tokenDecimals: 6,
  fees: PUMPFUN_CURVE_FEES,
  source: 'pumpfun-curve',
  slot: 0,
};

function event(state: PoolState, overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    mint: MINT,
    solAmount: 0n,
    tokenAmount: 0n,
    isBuy: true,
    user: 'user',
    timestamp: 1_700_000_000,
    virtualSolReserves: state.solReserve,
    virtualTokenReserves: state.tokenReserve,
    realSolReserves: 0n,
    realTokenReserves: state.deliverableTokens,
    ...overrides,
  };
}

/**
 * Build a run of events the way the chain would emit them: each one carries
 * the reserves *after* it, and the amounts are curve-side.
 */
function buildRun(sizes: readonly { side: 'buy' | 'sell'; size: bigint }[]): OrderedEvent[] {
  let state = START;
  const ordered: OrderedEvent[] = [{ event: event(state), slot: 0, indexInTx: 0 }];

  sizes.forEach((step, index) => {
    if (step.side === 'buy') {
      const quote = quoteBuy(state, step.size);
      const curveSide = quote.solAmount - quote.feeLamports;
      state = applyQuote(state, quote);
      ordered.push({
        event: event(state, { isBuy: true, solAmount: curveSide, tokenAmount: quote.tokenAmount }),
        slot: index + 1,
        indexInTx: 0,
      });
    } else {
      const quote = quoteSell(state, step.size);
      const curveSide = quote.solAmount + quote.feeLamports;
      state = applyQuote(state, quote);
      ordered.push({
        event: event(state, { isBuy: false, solAmount: curveSide, tokenAmount: quote.tokenAmount }),
        slot: index + 1,
        indexInTx: 0,
      });
    }
  });

  return ordered;
}

describe('isConsecutive', () => {
  it('accepts a genuine successor', () => {
    const run = buildRun([{ side: 'buy', size: 1_000_000_000n }]);
    expect(isConsecutive(run[0]!.event, run[1]!.event)).toBe(true);
  });

  it('rejects a pair with a missing trade between them', () => {
    // Reserve arithmetic that does not close means something moved the curve
    // that the walk did not see. Tolerating these and then reporting a low
    // median would be measuring the harness's own leniency.
    const run = buildRun([
      { side: 'buy', size: 1_000_000_000n },
      { side: 'buy', size: 1_000_000_000n },
    ]);
    expect(isConsecutive(run[0]!.event, run[2]!.event)).toBe(false);
  });

  it('rejects a sell mislabelled as a buy', () => {
    const run = buildRun([{ side: 'sell', size: 1_000_000_000_000n }]);
    const mislabelled = { ...run[1]!.event, isBuy: true };
    expect(isConsecutive(run[0]!.event, mislabelled)).toBe(false);
  });
});

describe('replay', () => {
  it('reproduces a clean run exactly', () => {
    const run = buildRun([
      { side: 'buy', size: 1_000_000_000n },
      { side: 'buy', size: 500_000_000n },
      { side: 'sell', size: 1_000_000_000_000n },
      { side: 'buy', size: 2_000_000_000n },
      { side: 'sell', size: 5_000_000_000_000n },
    ]);

    const report = replay(MINT, run, ENGINE_VERSION);
    expect(report.samples).toBe(5);
    expect(report.buys).toBe(3);
    expect(report.sells).toBe(2);
    expect(report.medianErrorBps).toBe(0);
    expect(report.maxErrorBps).toBe(0);
    expect(report.exactRate).toBe(1);
  });

  it('skips pairs that are not consecutive rather than scoring them', () => {
    const run = buildRun([
      { side: 'buy', size: 1_000_000_000n },
      { side: 'buy', size: 1_000_000_000n },
      { side: 'buy', size: 1_000_000_000n },
    ]);
    // Drop the middle event, leaving a gap the arithmetic will catch.
    const withGap = [run[0]!, run[2]!, run[3]!];

    const report = replay(MINT, withGap, ENGINE_VERSION);
    expect(report.skipped.not_consecutive).toBeGreaterThan(0);
    // The pair that does still line up is scored, and scored exactly.
    expect(report.maxErrorBps).toBe(0);
  });

  it('counts the first event as skipped', () => {
    const report = replay(MINT, buildRun([{ side: 'buy', size: 1_000_000_000n }]), ENGINE_VERSION);
    expect(report.skipped.first_event).toBe(1);
  });

  it('handles an empty run', () => {
    const report = replay(MINT, [], ENGINE_VERSION);
    expect(report.samples).toBe(0);
    expect(report.medianErrorBps).toBe(0);
    expect(report.exactRate).toBe(0);
  });

  it('records the engine version it measured', () => {
    const report = replay(MINT, buildRun([{ side: 'buy', size: 1_000_000n }]), ENGINE_VERSION);
    // A number without a version is meaningless — the engine changes.
    expect(report.engineVersion).toBe(ENGINE_VERSION);
  });

  it('reports the worst cases for inspection', () => {
    const run = buildRun([
      { side: 'buy', size: 1_000_000_000n },
      { side: 'sell', size: 1_000_000_000_000n },
    ]);
    const report = replay(MINT, run, ENGINE_VERSION);
    expect(report.worst.length).toBeGreaterThan(0);
    expect(report.worst[0]!.errorBps).toBe(0);
  });
});

describe('combine', () => {
  it('pools samples across tokens and keeps the worst percentiles', () => {
    const a = replay('a', buildRun([{ side: 'buy', size: 1_000_000_000n }]), ENGINE_VERSION);
    const b = replay('b', buildRun([{ side: 'sell', size: 1_000_000_000_000n }]), ENGINE_VERSION);

    const total = combine('all', [a, b]);
    expect(total.samples).toBe(a.samples + b.samples);
    // Percentiles cannot be averaged, so the worst is reported rather than a
    // number that would flatter the result.
    expect(total.maxErrorBps).toBe(Math.max(a.maxErrorBps, b.maxErrorBps));
  });

  it('handles no reports', () => {
    const total = combine('all', []);
    expect(total.samples).toBe(0);
  });
});

describe('formatReport', () => {
  it('renders the figures a reader needs', () => {
    const report = replay(MINT, buildRun([{ side: 'buy', size: 1_000_000_000n }]), ENGINE_VERSION);
    const text = formatReport(report);

    expect(text).toContain('median error');
    expect(text).toContain('exact matches');
    expect(text).toContain(`engine version  ${ENGINE_VERSION}`);
  });
});
