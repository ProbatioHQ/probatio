import { describe, expect, it } from 'vitest';
import { exitDecision, type ExitRules } from '@probatio/sim';

/**
 * The two-stage exit, and why the second stage cannot be dropped.
 *
 * The runner screens every open position against the last known price, which is
 * free, and only reads the chain when that screen says a level is plausibly
 * crossed. The screen is a mid: what an infinitely small trade would get. A real
 * exit is always worse, by the fee and by this position's own impact, and the
 * gap widens exactly as a position grows large against its pool — which is
 * exactly when a take profit fires.
 *
 * So these fix the arithmetic that decides when the screen is allowed to say
 * "not yet". Getting it wrong in one direction costs a chain read; getting it
 * wrong in the other means a stop loss that never fires until the position is
 * far further under water than it was set.
 */

/** The runner's own margin. Kept here so the test breaks if it moves silently. */
const SCREEN_MARGIN_BPS = 500;

const EXIT: ExitRules = { takeProfitBps: 12_000, stopLossBps: 4_000, timeoutSeconds: 600 };

/**
 * The runner's screen: is this position nowhere near any of its levels?
 *
 * Widened in both directions, because a mid overstates what a sell fetches and
 * the true figure could be on either side of the screened one.
 */
function nowhereNear(exit: ExitRules, screenedBps: number, heldSeconds: number): boolean {
  return (
    exitDecision(exit, { movedBps: screenedBps + SCREEN_MARGIN_BPS, heldSeconds }) === null &&
    exitDecision(exit, { movedBps: screenedBps - SCREEN_MARGIN_BPS, heldSeconds }) === null
  );
}

describe('the free screen', () => {
  it('says nothing to do when a position is well inside its levels', () => {
    // No chain read, no credits spent. This is the common case and it is what
    // makes a strategy that is holding and waiting cost nothing.
    expect(nowhereNear(EXIT, 2_000, 60)).toBe(true);
  });

  it('asks the chain as a take profit comes into range', () => {
    expect(nowhereNear(EXIT, 11_600, 60)).toBe(false);
  });

  /*
   * The one that matters. A mid is optimistic, so a position the screen reports
   * at 36% down may really be past a 40% stop. Screening exactly at the level
   * would look and see nothing, and the stop would fire on some later tick from
   * much further down.
   */
  it('asks the chain before a stop is reached, not after', () => {
    expect(nowhereNear(EXIT, -3_600, 60)).toBe(false);
    expect(nowhereNear(EXIT, -3_400, 60)).toBe(true);
  });

  it('lets the chain have the final word either way', () => {
    // Screened past the take profit, but the real exit is not: still holding.
    expect(exitDecision(EXIT, { movedBps: 11_400, heldSeconds: 60 })).toBeNull();
    // And the same position once a real sell would actually clear it.
    expect(exitDecision(EXIT, { movedBps: 12_100, heldSeconds: 60 })).toBe('take_profit');
  });

  it('never screens out a timeout, because a clock is not a price', () => {
    // No quote can change how long something has been held, so the runner takes
    // this branch before it looks at any price at all.
    expect(nowhereNear(EXIT, 0, 600)).toBe(false);
    expect(exitDecision(EXIT, { movedBps: 0, heldSeconds: 600 })).toBe('timeout');
  });

  it('holds a position with no price to screen against', () => {
    // The runner pays for a quote rather than guessing when nothing has priced
    // a token recently. That is rare and it is the honest branch.
    const rules: ExitRules = { takeProfitBps: 12_000 };
    expect(nowhereNear(rules, 0, 10)).toBe(true);
  });
});

describe('what the screen must never do', () => {
  /*
   * A rule with only a timeout has no price level at all, so the runner skips
   * the price path entirely. If this ever started reading the chain it would be
   * a credit spent per position per tick, for an answer time already had.
   */
  it('needs no price for a timeout-only rule', () => {
    const rules: ExitRules = { timeoutSeconds: 300 };
    expect(exitDecision(rules, { movedBps: -9_000, heldSeconds: 299 })).toBeNull();
    expect(exitDecision(rules, { movedBps: 0, heldSeconds: 300 })).toBe('timeout');
  });

  it('keeps the stop ahead of the take profit when both are crossed', () => {
    // The pessimistic order, checked here as well as in the engine, because the
    // runner and the backtester both depend on it and it is one function.
    expect(exitDecision(EXIT, { movedBps: -20_000, heldSeconds: 5 })).toBe('stop_loss');
  });
});
