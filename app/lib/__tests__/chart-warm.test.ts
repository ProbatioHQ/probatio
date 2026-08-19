import { describe, expect, it } from 'vitest';
import { chooseMint } from '../chart-warm';

/**
 * Which token gets warmed next.
 *
 * The warmer has no output anybody watches, so its failures are all of the
 * same kind: it keeps running, and quietly stops making progress. A cycle that
 * settles on one mint, or a map that grows for the life of the process, looks
 * exactly like a healthy warmer from outside. These are the choices where that
 * can happen.
 */

const NEVER_IN_FLIGHT = (): boolean => false;
const HOUR = 60 * 60 * 1_000;

describe('chooseMint', () => {
  it('takes the ranked list in order, so the biggest tokens warm first', () => {
    const chosen = chooseMint(['a', 'b', 'c'], new Map(), 0, NEVER_IN_FLIGHT);
    expect(chosen).toBe('a');
  });

  it('skips a token warmed recently and moves on to the next', () => {
    const warmed = new Map([['a', 0]]);
    expect(chooseMint(['a', 'b'], warmed, HOUR, NEVER_IN_FLIGHT, 6 * HOUR)).toBe('b');
  });

  it('comes back to a token once its history has gone stale', () => {
    const warmed = new Map([['a', 0]]);
    expect(chooseMint(['a'], warmed, 7 * HOUR, NEVER_IN_FLIGHT, 6 * HOUR)).toBe('a');
  });

  it('leaves a token alone while somebody is opening it', () => {
    const inFlight = (mint: string): boolean => mint === 'a';
    expect(chooseMint(['a', 'b'], new Map(), 0, inFlight)).toBe('b');
  });

  it('returns null when every token is current', () => {
    const warmed = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    expect(chooseMint(['a', 'b'], warmed, HOUR, NEVER_IN_FLIGHT, 6 * HOUR)).toBeNull();
  });

  /*
   * The whole cycle must not be spent on one mint.
   *
   * A token pump.fun cannot serve candles for fails every time it is tried. The
   * caller records the attempt rather than the success, so the failure has to
   * count as "seen" here: were this to skip anything that had not been warmed
   * successfully, that one mint would be the answer to "what is next" for ever
   * and the other seven hundred and ninety-nine would never be reached.
   */
  it('treats a recorded attempt as done, so a token that cannot warm cannot wedge the cycle', () => {
    const warmed = new Map([['broken', 0]]);
    expect(chooseMint(['broken', 'b'], warmed, HOUR, NEVER_IN_FLIGHT, 6 * HOUR)).toBe('b');
  });

  /*
   * The map is bounded by the ranking, not by uptime.
   *
   * Tokens leave the top few hundred every day. Without this the map keeps
   * every mint the job has ever seen, which is a slow leak over a long uptime
   * of exactly the kind that only shows up in production weeks later.
   */
  it('forgets tokens that have dropped off the list', () => {
    const warmed = new Map([
      ['still-listed', 0],
      ['dropped-off', 0],
    ]);
    chooseMint(['still-listed'], warmed, HOUR, NEVER_IN_FLIGHT, 6 * HOUR);
    expect([...warmed.keys()]).toEqual(['still-listed']);
  });

  it('does not forget anything while there is still work to do', () => {
    const warmed = new Map([['dropped-off', 0]]);
    // 'fresh' is owed a warm, so the pass returns before the sweep.
    chooseMint(['fresh'], warmed, HOUR, NEVER_IN_FLIGHT, 6 * HOUR);
    expect(warmed.has('dropped-off')).toBe(true);
  });
});
