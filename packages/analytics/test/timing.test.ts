import { describe, expect, it } from 'vitest';
import { computeTimeOfDay } from '../src/timing';
import type { RoundTrip } from '../src/roundtrips';

/** 2024-01-03 was a Wednesday. */
function at(hourUtc: number, day = 3): number {
  return Date.UTC(2024, 0, day, hourUtc, 30, 0);
}

function trip(realized: bigint, openedAt: number): RoundTrip {
  return {
    mint: 'M',
    openedAt,
    closedAt: openedAt + 60_000,
    heldMs: 60_000,
    invested: 1_000n,
    proceeds: 1_000n + realized,
    realized,
    feesPaid: 0n,
    buys: 1,
    sells: 1,
    peakTokens: 1n,
    tokensBought: 1n,
    tokensSold: 1n,
    trades: [],
  };
}

describe('bucketing by hour', () => {
  it('has a bucket for every hour whether used or not', () => {
    const result = computeTimeOfDay([]);
    expect(result.hours).toHaveLength(24);
    expect(result.daysOfWeek).toHaveLength(7);
    expect(result.hours[0]!.winRateBps).toBeNull();
  });

  it('files a trip under the hour it was opened, in UTC', () => {
    const result = computeTimeOfDay([trip(100n, at(14))]);

    expect(result.hours[14]!.trips).toBe(1);
    expect(result.hours[14]!.realized).toBe(100n);
    expect(result.hours[14]!.winRateBps).toBe(10_000);
  });

  it('files by the day of week too', () => {
    const result = computeTimeOfDay([trip(100n, at(14, 3))]);
    // 2024-01-03 is a Wednesday, which is index 3.
    expect(result.daysOfWeek[3]!.trips).toBe(1);
  });

  it('bucketed by the entry, not the exit', () => {
    // Opened at 23:30, closed the next day. The decision was made at 23.
    const result = computeTimeOfDay([trip(100n, at(23))]);
    expect(result.hours[23]!.trips).toBe(1);
    expect(result.hours[0]!.trips).toBe(0);
  });
});

describe('naming a best and worst hour', () => {
  it('ignores an hour with too few trades to mean anything', () => {
    // One enormous win at 4am against a steady record at 15:00. A single
    // sample is luck, and calling it the best hour would send someone to
    // trade at 4am on the strength of one trade.
    const result = computeTimeOfDay([
      trip(1_000_000n, at(4)),
      trip(100n, at(15)),
      trip(100n, at(15)),
      trip(100n, at(15)),
    ]);

    expect(result.bestHour?.index).toBe(15);
  });

  it('names nothing when no hour clears the bar', () => {
    const result = computeTimeOfDay([trip(100n, at(4)), trip(100n, at(9))]);
    expect(result.bestHour).toBeNull();
    expect(result.worstHour).toBeNull();
  });

  it('finds the worst hour by money lost, not by count', () => {
    const trips = [
      ...[0, 1, 2].map(() => trip(-10_000n, at(2))),
      ...[0, 1, 2, 3, 4, 5].map(() => trip(-100n, at(20))),
    ];

    const result = computeTimeOfDay(trips);
    expect(result.worstHour?.index).toBe(2);
    expect(result.worstHour?.realized).toBe(-30_000n);
  });

  it('honours a caller who wants a different bar', () => {
    const result = computeTimeOfDay([trip(500n, at(4))], 1);
    expect(result.bestHour?.index).toBe(4);
    expect(result.minTrips).toBe(1);
  });
});
