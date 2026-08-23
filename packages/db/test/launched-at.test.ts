import { describe, expect, it } from 'vitest';
import { launchedAtMs } from '../src/index';

/**
 * One column, two units.
 *
 * The websocket feed that first indexed launches wrote seconds. The polled feed
 * that replaced it writes what pump.fun sends, which is milliseconds. Measured
 * on production: of 180 rows, 167 were milliseconds and 13 were seconds, in the
 * same column, with nothing in the row to say which.
 *
 * Every consumer then assumed seconds, so a launch time in milliseconds made
 * the token page read "launched 58613-07-31", made every age in the feed read
 * as nought seconds, and made every token paint as launched within the hour.
 */
describe('a launch time, whichever unit it was stored in', () => {
  const MS = 1_787_500_818_000; // what the polled feed writes
  const SECONDS = 1_786_994_035; // what the old websocket feed wrote

  it('leaves milliseconds alone', () => {
    expect(launchedAtMs(MS)).toBe(MS);
  });

  it('lifts seconds to milliseconds', () => {
    expect(launchedAtMs(SECONDS)).toBe(SECONDS * 1000);
  });

  /* Both land in the same week rather than thirty thousand years apart. */
  it('puts both in the same era', () => {
    const a = new Date(launchedAtMs(MS)).getUTCFullYear();
    const b = new Date(launchedAtMs(SECONDS)).getUTCFullYear();
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(2020);
    expect(a).toBeLessThan(2100);
  });

  /*
   * The boundary is not a close call, which is what makes the guess safe: a
   * launch is around 1.79e12 in milliseconds and 1.79e9 in seconds, and nothing
   * real sits between them.
   */
  it('separates the two by a wide margin', () => {
    expect(MS / SECONDS).toBeGreaterThan(500);
  });

  it('says nothing rather than 1970 when there is no time', () => {
    expect(launchedAtMs(0)).toBe(0);
    expect(launchedAtMs(null)).toBe(0);
    expect(launchedAtMs(undefined)).toBe(0);
    expect(launchedAtMs('nonsense')).toBe(0);
  });
});
