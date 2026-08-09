import { describe, expect, it } from 'vitest';
import {
  RANKED_COOLDOWN_MS,
  WEEK_MS,
  entitlement,
  explainRefusal,
  type EntitlementInput,
} from '../src/entitlement';

const NOW = 1_700_000_000_000;

function input(overrides: Partial<EntitlementInput> = {}): EntitlementInput {
  return {
    tier: 'free',
    now: NOW,
    lastReportAt: null,
    tripsAtLastReport: 0,
    tripsNow: 10,
    minimumTrips: 5,
    ...overrides,
  };
}

describe('who may ask', () => {
  it('refuses a record too short to say anything about', () => {
    const result = entitlement(input({ tripsNow: 4 }));
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe('not_enough_trades');
  });

  it('allows the first report with no other conditions', () => {
    expect(entitlement(input()).allowed).toBe(true);
  });

  it('refuses when nothing has happened since the last one', () => {
    // The same numbers produce the same advice, and charge for it.
    const result = entitlement(
      input({ lastReportAt: NOW - WEEK_MS * 2, tripsAtLastReport: 10, tripsNow: 10 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe('nothing_new');
  });
});

describe('free', () => {
  it('gets one a week', () => {
    const recent = entitlement(
      input({ lastReportAt: NOW - WEEK_MS + 1, tripsAtLastReport: 5, tripsNow: 10 }),
    );
    expect(recent.allowed).toBe(false);
    expect(recent.refusal).toBe('cooldown');
    expect(recent.nextAllowedAt).toBe(NOW - WEEK_MS + 1 + WEEK_MS);
  });

  it('is allowed again once the week is up', () => {
    const result = entitlement(
      input({ lastReportAt: NOW - WEEK_MS, tripsAtLastReport: 5, tripsNow: 10 }),
    );
    expect(result.allowed).toBe(true);
  });

  it('is not helped by an hour passing', () => {
    const result = entitlement(
      input({ lastReportAt: NOW - RANKED_COOLDOWN_MS, tripsAtLastReport: 5, tripsNow: 10 }),
    );
    expect(result.allowed).toBe(false);
  });
});

describe('ranked', () => {
  it('gets one per session rather than one per week', () => {
    const result = entitlement(
      input({
        tier: 'ranked',
        lastReportAt: NOW - RANKED_COOLDOWN_MS,
        tripsAtLastReport: 5,
        tripsNow: 10,
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it('still waits out its own cooldown', () => {
    const result = entitlement(
      input({
        tier: 'ranked',
        lastReportAt: NOW - 60_000,
        tripsAtLastReport: 5,
        tripsNow: 10,
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe('cooldown');
  });

  it('still needs something to have happened', () => {
    const result = entitlement(
      input({
        tier: 'ranked',
        lastReportAt: NOW - WEEK_MS,
        tripsAtLastReport: 10,
        tripsNow: 10,
      }),
    );
    expect(result.refusal).toBe('nothing_new');
  });
});

describe('explaining a refusal', () => {
  it('tells a free account what it gets', () => {
    expect(explainRefusal('cooldown', 'free', 5)).toContain('one report a week');
  });

  it('does not lecture a paying account about the free tier', () => {
    expect(explainRefusal('cooldown', 'ranked', 5)).not.toContain('Free accounts');
  });

  it('names the number of trades needed', () => {
    expect(explainRefusal('not_enough_trades', 'free', 5)).toContain('5');
  });
});
