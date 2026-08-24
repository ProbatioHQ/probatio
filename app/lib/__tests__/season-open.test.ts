import { describe, expect, it } from 'vitest';
import type { SeasonRow } from '@probatio/db';
import { seasonTradingOpen, whyNotOpen } from '../season-open';

/**
 * When a season is open to trade in.
 *
 * These exist because of a bug that only ever hit strategies, and only ever on
 * the days that matter most. Every human path asked `tradingOpen`, which counts
 * the entry window; the strategy runner and the start route asked the stored
 * `status` column for the string `'running'`, which the entry window is not.
 *
 * So for the first two days of every season an algorithm could be written and
 * saved and could not be started, and one already running was stopped and told
 * "the season is no longer running" about a season that had begun that morning.
 * The message was as wrong as the gate: nothing had ended.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function season(overrides: Partial<SeasonRow> = {}): SeasonRow {
  return {
    id: 1,
    ordinal: 1,
    name: 'Season 1',
    ranked: true,
    status: 'entry_open',
    startsAt: 0,
    endsAt: 7 * DAY,
    entryOpensAt: 0,
    entryClosesAt: 2 * DAY,
    startingBalance: '10000000000',
    entryCost: '0',
    rulesetHash: 'deadbeef',
    ...overrides,
  } as SeasonRow;
}

describe('a season open to trade in', () => {
  it('is open during the entry window', () => {
    // The case the runner got wrong. Day one of a fortnight is not "no longer
    // running", and a trade placed in it counts toward the board.
    expect(seasonTradingOpen(season(), HOUR)).toBe(true);
    expect(seasonTradingOpen(season(), 2 * DAY - 1)).toBe(true);
  });

  it('is open after entries close', () => {
    expect(seasonTradingOpen(season(), 3 * DAY)).toBe(true);
  });

  it('is shut before it starts and once it has ended', () => {
    expect(seasonTradingOpen(season({ startsAt: DAY }), 0)).toBe(false);
    expect(seasonTradingOpen(season(), 7 * DAY)).toBe(false);
    expect(seasonTradingOpen(season(), 8 * DAY)).toBe(false);
  });

  it('is shut once a results root is on chain', () => {
    // Finalized is a stored fact rather than a time, and it outranks the clock.
    expect(seasonTradingOpen(season({ status: 'finalized' }), HOUR)).toBe(false);
  });

  it('does not trust the status column over the clock', () => {
    /*
     * The whole point. The column is written by a job; a job that has not run
     * yet leaves it saying something the timestamps disagree with, and the
     * timestamps are the season.
     */
    expect(seasonTradingOpen(season({ status: 'pending' }), HOUR)).toBe(true);
    expect(seasonTradingOpen(season({ status: 'running' }), 8 * DAY)).toBe(false);
  });

  it('is shut when a season has no timestamps to judge by', () => {
    // Refusing rather than guessing: a season with no start is not a season
    // anybody can be trading in.
    expect(seasonTradingOpen(season({ startsAt: null }), HOUR)).toBe(false);
    expect(seasonTradingOpen(season({ endsAt: null }), HOUR)).toBe(false);
  });

  it('treats a missing entry close as entries never closing', () => {
    expect(seasonTradingOpen(season({ entryClosesAt: null }), 3 * DAY)).toBe(true);
  });
});

describe('what a stopped strategy is told', () => {
  it('says the season has not started, rather than that it ended', () => {
    expect(whyNotOpen(season({ startsAt: DAY }), 0)).toBe('the season has not started yet');
  });

  it('says the season has finished when it has', () => {
    expect(whyNotOpen(season(), 8 * DAY)).toBe('the season has finished');
  });

  it('says there is no season when there is none', () => {
    expect(whyNotOpen(null, 0)).toBe('there is no season to trade in');
  });

  it('never claims a season ended while it is still running', () => {
    // The sentence that was recorded on people's strategies on opening day.
    expect(whyNotOpen(season(), HOUR)).not.toContain('finished');
  });
});
