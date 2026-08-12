import { describe, expect, it } from 'vitest';
import {
  entryOpen,
  scheduleFrom,
  statusAt,
  timeUntilEntryCloses,
  tradingOpen,
  type SeasonTiming,
} from '../src/lifecycle';

const START = 1_700_000_000_000;
const DAY = 86_400_000;

function timing(overrides: Partial<SeasonTiming> = {}): SeasonTiming {
  return {
    startsAt: START,
    endsAt: START + 7 * DAY,
    entryClosesAt: START + 2 * DAY,
    finalizedAt: null,
    ...overrides,
  };
}

describe('what a season is doing', () => {
  it('is pending before it starts', () => {
    expect(statusAt(timing(), START - 1)).toBe('pending');
  });

  it('opens entries the moment it starts', () => {
    expect(statusAt(timing(), START)).toBe('entry_open');
  });

  it('is still taking entries a second before the window shuts', () => {
    expect(statusAt(timing(), START + 2 * DAY - 1)).toBe('entry_open');
  });

  it('keeps running once entries close', () => {
    expect(statusAt(timing(), START + 2 * DAY)).toBe('running');
    expect(statusAt(timing(), START + 6 * DAY)).toBe('running');
  });

  it('closes at the end', () => {
    expect(statusAt(timing(), START + 7 * DAY)).toBe('closed');
  });

  it('is finalized once a root is on chain, whatever the clock says', () => {
    // The only status that is an event rather than a time.
    expect(statusAt(timing({ finalizedAt: START }), START + 999 * DAY)).toBe('finalized');
    expect(statusAt(timing({ finalizedAt: START }), START - 999 * DAY)).toBe('finalized');
  });
});

describe('what is allowed when', () => {
  it('only takes entries during the window', () => {
    expect(entryOpen(timing(), START - 1)).toBe(false);
    expect(entryOpen(timing(), START + DAY)).toBe(true);
    expect(entryOpen(timing(), START + 3 * DAY)).toBe(false);
  });

  it('counts trades for the whole season, not just the entry window', () => {
    // Entries close at 48 hours; the season runs a week. A trader who entered
    // on day one is still trading on day six.
    expect(tradingOpen(timing(), START + 6 * DAY)).toBe(true);
    expect(tradingOpen(timing(), START + 7 * DAY)).toBe(false);
    expect(tradingOpen(timing(), START - 1)).toBe(false);
  });

  it('counts down to the entry deadline and then stops', () => {
    expect(timeUntilEntryCloses(timing(), START + DAY)).toBe(DAY);
    expect(timeUntilEntryCloses(timing(), START + 3 * DAY)).toBeNull();
  });
});

describe('scheduling', () => {
  it('runs for the duration it was given', () => {
    const schedule = scheduleFrom(START, 7 * DAY, 2 * DAY);
    expect(schedule.endsAt - schedule.startsAt).toBe(7 * DAY);
    expect(schedule.entryClosesAt).toBe(START + 2 * DAY);
  });

  it('never lets entries outlast the season', () => {
    // A one-day season cannot have a two-day entry window.
    const schedule = scheduleFrom(START, DAY, 2 * DAY);
    expect(schedule.entryClosesAt).toBe(schedule.endsAt);
  });

  it('starts the next season exactly where the last ended', () => {
    // No gap. A gap is a stretch where a ranked trade counts toward nothing.
    // Derive the boundary independently rather than reading it back out of
    // `first`: asserting second.startsAt === first.endsAt is trivially true
    // because scheduleFrom returns its start argument verbatim, so it would pass
    // even if endsAt were computed wrong. Pinning both to START + 7 days checks
    // the actual duration math and the contiguity together.
    const first = scheduleFrom(START, 7 * DAY, 2 * DAY);
    const second = scheduleFrom(first.endsAt, 14 * DAY, 2 * DAY);
    expect(first.endsAt).toBe(START + 7 * DAY);
    expect(second.startsAt).toBe(START + 7 * DAY);
  });
});
