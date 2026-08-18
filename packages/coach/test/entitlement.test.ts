import { describe, expect, it } from 'vitest';
import {
  TRIPS_PER_REPORT,
  entitlement,
  explainRefusal,
  type EntitlementInput,
} from '../src/entitlement';

/**
 * A report is earned by trading, not by waiting.
 *
 * The rule used to be a clock: one a week on free, one an hour on ranked. A
 * clock says nothing about whether a record reads differently, which is the
 * only thing that makes a second report worth writing. A week of not trading
 * produces the report that was already given, and an afternoon of twenty trades
 * produces a genuinely different record that a weekly limit would sit on.
 */

const MINIMUM = 5;

function ask(over: Partial<EntitlementInput> = {}) {
  return entitlement({
    tier: 'free',
    now: 1_000,
    lastReportAt: null,
    tripsAtLastReport: 0,
    tripsNow: MINIMUM,
    minimumTrips: MINIMUM,
    ...over,
  });
}

describe('the first report', () => {
  it('waits for a record worth reading', () => {
    const state = ask({ tripsNow: 4 });
    expect(state.allowed).toBe(false);
    expect(state.refusal).toBe('not_enough_trades');
    expect(state.tripsUntilNext).toBe(1);
  });

  it('is allowed the moment the minimum is closed', () => {
    expect(ask({ tripsNow: MINIMUM }).allowed).toBe(true);
  });

  it('does not wait on a clock', () => {
    // Any instant at all: nothing here reads the time.
    expect(ask({ now: 0 }).allowed).toBe(true);
    expect(ask({ now: Number.MAX_SAFE_INTEGER }).allowed).toBe(true);
  });
});

describe('every report after the first', () => {
  const after = (tripsNow: number) =>
    ask({ lastReportAt: 500, tripsAtLastReport: MINIMUM, tripsNow });

  it('needs another five closed', () => {
    expect(after(MINIMUM).allowed).toBe(false);
    expect(after(MINIMUM + 1).allowed).toBe(false);
    expect(after(MINIMUM + TRIPS_PER_REPORT).allowed).toBe(true);
  });

  it('counts down the trades still to close', () => {
    expect(after(MINIMUM + 1).tripsUntilNext).toBe(TRIPS_PER_REPORT - 1);
    expect(after(MINIMUM + 4).tripsUntilNext).toBe(1);
  });

  it('says the count the next one unlocks at, to show progress against', () => {
    expect(after(MINIMUM + 2).unlocksAtTrips).toBe(MINIMUM + TRIPS_PER_REPORT);
  });

  it('stays allowed once past the mark, however far past', () => {
    // Somebody who traded fifty more is owed one, not locked out for overshooting.
    expect(after(MINIMUM + 50).allowed).toBe(true);
  });

  it('never refuses on time, however recent the last one', () => {
    const state = ask({
      lastReportAt: 999,
      now: 1_000,
      tripsAtLastReport: MINIMUM,
      tripsNow: MINIMUM + TRIPS_PER_REPORT,
    });
    expect(state.allowed).toBe(true);
  });
});

describe('what a refusal says', () => {
  it('counts trades rather than naming a policy', () => {
    expect(explainRefusal('need_more_trades', 3, MINIMUM)).toContain('3 trades');
    expect(explainRefusal('not_enough_trades', 1, MINIMUM)).toContain('1 trade');
  });

  it('never says a plural of one', () => {
    expect(explainRefusal('need_more_trades', 1, MINIMUM)).not.toContain('1 trades');
  });
});
