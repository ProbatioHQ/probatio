import { beforeEach, describe, expect, it } from 'vitest';
import { openStreamCount, takeStreamSlot } from '../launch-stream';

/**
 * The limit on open streams.
 *
 * This is the only thing standing between one caller and every stream slot on
 * the server. The rate limiter does not help: it counts requests, and a stream
 * is one request held open indefinitely. So the accounting gets tested rather
 * than assumed — particularly the release path, because a slot that leaks on
 * disconnect turns a working limit into a countdown.
 */

const CALLER = 'wallet:9oNfewPW6KSxbKbTUCQ3g7tc2gViCEYijc6TbDaumwg1';
const OTHER = 'ip:203.0.113.7';

/** The registry is a process-wide global, so each test has to clean up after itself. */
const held: { release(): void }[] = [];

function take(caller: string) {
  const slot = takeStreamSlot(caller);
  if (slot.granted) held.push(slot);
  return slot;
}

beforeEach(() => {
  while (held.length > 0) held.pop()?.release();
  expect(openStreamCount()).toBe(0);
});

describe('stream slots', () => {
  it('lets one caller hold a few at once', () => {
    expect(take(CALLER).granted).toBe(true);
    expect(take(CALLER).granted).toBe(true);
    expect(take(CALLER).granted).toBe(true);
    expect(openStreamCount()).toBe(3);
  });

  it('refuses the one past the limit', () => {
    take(CALLER);
    take(CALLER);
    take(CALLER);
    expect(takeStreamSlot(CALLER).granted).toBe(false);
  });

  it('does not count a refused slot against the total', () => {
    take(CALLER);
    take(CALLER);
    take(CALLER);
    takeStreamSlot(CALLER);
    takeStreamSlot(CALLER);
    // A rejection that still incremented would make the limit tighten every
    // time somebody retried, until nobody could connect at all.
    expect(openStreamCount()).toBe(3);
  });

  it('frees the slot when the connection closes', () => {
    const first = takeStreamSlot(CALLER);
    take(CALLER);
    take(CALLER);
    expect(takeStreamSlot(CALLER).granted).toBe(false);

    first.release();
    const after = takeStreamSlot(CALLER);
    expect(after.granted).toBe(true);
    after.release();
  });

  it('ignores a second release of the same slot', () => {
    const slot = takeStreamSlot(CALLER);
    take(CALLER);
    slot.release();
    // Close fires from an abort and again from the teardown that follows it.
    // Counting both would hand back a slot that was never taken.
    slot.release();
    expect(openStreamCount()).toBe(1);
  });

  it('releasing a refused slot changes nothing', () => {
    take(CALLER);
    take(CALLER);
    take(CALLER);
    const refused = takeStreamSlot(CALLER);
    expect(refused.granted).toBe(false);
    refused.release();
    expect(openStreamCount()).toBe(3);
  });

  it('limits each caller separately', () => {
    take(CALLER);
    take(CALLER);
    take(CALLER);
    // One caller exhausting their own allowance must not lock out everyone else.
    expect(take(OTHER).granted).toBe(true);
    expect(openStreamCount()).toBe(4);
  });

  it('forgets a caller once they hold nothing', () => {
    const slot = takeStreamSlot(CALLER);
    slot.release();
    expect(openStreamCount()).toBe(0);
    // Otherwise the map grows by one entry per visitor, forever.
    expect(takeStreamSlot(CALLER).granted).toBe(true);
    takeStreamSlot(CALLER);
  });
});
