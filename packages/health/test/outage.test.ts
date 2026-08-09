import { describe, expect, it } from 'vitest';
import { currentlyDown, outageMinutes, outageMs, type Outage } from '../src/outage';

const T = 1_700_000_000_000;
const MIN = 60_000;
const NOW = T + 1_000 * MIN;

function outage(startedAt: number, endedAt: number | null, dependency: Outage['dependency'] = 'rpc'): Outage {
  return { dependency, startedAt, endedAt, detail: null };
}

describe('measuring downtime', () => {
  it('is zero with no outages', () => {
    expect(outageMs([], T, T + 100 * MIN, NOW)).toBe(0);
  });

  it('measures a closed outage', () => {
    expect(outageMinutes([outage(T + 10 * MIN, T + 25 * MIN)], T, T + 100 * MIN, NOW)).toBe(15);
  });

  it('counts an open outage up to now, not forever', () => {
    const now = T + 30 * MIN;
    expect(outageMinutes([outage(T + 10 * MIN, null)], T, T + 100 * MIN, now)).toBe(20);
  });

  it('clips an outage to the window asked about', () => {
    // A season asks about its own span, not about all of history.
    const long = outage(T - 500 * MIN, T + 5 * MIN);
    expect(outageMinutes([long], T, T + 100 * MIN, NOW)).toBe(5);
  });

  it('ignores an outage outside the window entirely', () => {
    expect(outageMs([outage(T - 50 * MIN, T - 10 * MIN)], T, T + 100 * MIN, NOW)).toBe(0);
  });

  it('adds separate outages', () => {
    const outages = [outage(T + 5 * MIN, T + 10 * MIN), outage(T + 20 * MIN, T + 35 * MIN)];
    expect(outageMinutes(outages, T, T + 100 * MIN, NOW)).toBe(20);
  });
});

describe('not double counting', () => {
  it('merges overlapping outages', () => {
    // Two probes disagreeing, or one incident recorded by two instances, would
    // otherwise report more downtime than the clock contains — and this number
    // decides whether a season is void.
    const outages = [outage(T + 10 * MIN, T + 30 * MIN), outage(T + 20 * MIN, T + 40 * MIN)];
    expect(outageMinutes(outages, T, T + 100 * MIN, NOW)).toBe(30);
  });

  it('merges an outage entirely inside another', () => {
    const outages = [outage(T + 10 * MIN, T + 60 * MIN), outage(T + 20 * MIN, T + 30 * MIN)];
    expect(outageMinutes(outages, T, T + 100 * MIN, NOW)).toBe(50);
  });

  it('merges duplicates of the same incident', () => {
    const one = outage(T + 10 * MIN, T + 30 * MIN);
    expect(outageMinutes([one, one, one], T, T + 100 * MIN, NOW)).toBe(20);
  });

  it('joins outages that touch exactly', () => {
    const outages = [outage(T + 10 * MIN, T + 20 * MIN), outage(T + 20 * MIN, T + 30 * MIN)];
    expect(outageMinutes(outages, T, T + 100 * MIN, NOW)).toBe(20);
  });

  it('keeps a gap between outages a gap', () => {
    const outages = [outage(T + 10 * MIN, T + 20 * MIN), outage(T + 21 * MIN, T + 30 * MIN)];
    expect(outageMinutes(outages, T, T + 100 * MIN, NOW)).toBe(19);
  });
});

describe('rounding', () => {
  it('rounds up to the minute', () => {
    // Reporting 119 minutes of a 119.6 minute outage against a 120 minute
    // threshold decides a season on a rounding choice.
    expect(outageMinutes([outage(T, T + 119 * MIN + 36_000)], T, NOW, NOW)).toBe(120);
  });

  it('reports a short blip as a minute rather than nothing', () => {
    expect(outageMinutes([outage(T, T + 1_000)], T, NOW, NOW)).toBe(1);
  });
});

describe('what is down now', () => {
  it('lists only open outages', () => {
    const outages = [outage(T, T + MIN, 'rpc'), outage(T, null, 'feed')];
    expect(currentlyDown(outages)).toEqual(['feed']);
  });

  it('lists a dependency once however many rows it has', () => {
    expect(currentlyDown([outage(T, null, 'rpc'), outage(T + MIN, null, 'rpc')])).toEqual(['rpc']);
  });

  it('lists nothing when everything is up', () => {
    expect(currentlyDown([outage(T, T + MIN)])).toEqual([]);
  });
});
