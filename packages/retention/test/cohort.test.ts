import { describe, expect, it } from 'vitest';
import { cohorts, dayNumber, dayString, summarize, type Activity } from '../src/cohort';

const D0 = dayNumber(Date.UTC(2026, 0, 1));

function seen(pubkey: string, offset: number, traded = false): Activity {
  return { pubkey, day: D0 + offset, traded };
}

describe('days', () => {
  it('are UTC', () => {
    // A cohort boundary that moves with the reader is not a boundary.
    expect(dayNumber(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(D0);
    expect(dayNumber(Date.UTC(2026, 0, 1, 23, 59, 59))).toBe(D0);
    expect(dayNumber(Date.UTC(2026, 0, 2, 0, 0, 0))).toBe(D0 + 1);
  });

  it('render as a date', () => {
    expect(dayString(D0)).toBe('2026-01-01');
  });
});

describe('building cohorts', () => {
  it('groups wallets by the day they first appeared', () => {
    const list = cohorts([seen('a', 0), seen('b', 0), seen('c', 3)], { today: D0 + 10 });

    expect(list).toHaveLength(2);
    expect(list[0]!.size).toBe(2);
    expect(list[1]!.day).toBe(D0 + 3);
  });

  it('counts everybody as present on their own first day', () => {
    expect(cohorts([seen('a', 0)], { today: D0 + 10 })[0]!.returnBps[0]).toBe(10_000);
  });

  it('measures who came back', () => {
    const list = cohorts(
      [seen('a', 0), seen('b', 0), seen('c', 0), seen('d', 0), seen('a', 1), seen('b', 1)],
      { today: D0 + 10 },
    );
    expect(list[0]!.returnBps[1]).toBe(5_000);
  });

  it('does not require consecutive days', () => {
    // Somebody who skips a day and comes back on day 7 is retained on day 7.
    const list = cohorts([seen('a', 0), seen('a', 7)], { today: D0 + 10 });
    expect(list[0]!.returnBps[1]).toBe(0);
    expect(list[0]!.returnBps[7]).toBe(10_000);
  });

  it('keeps a wallet in the cohort it joined, whenever it returns', () => {
    const list = cohorts([seen('a', 0), seen('a', 5), seen('b', 5)], { today: D0 + 10 });
    expect(list[0]!.size).toBe(1);
    expect(list[1]!.size).toBe(1);
  });

  it('counts a wallet once however many times it was seen in a day', () => {
    const list = cohorts([seen('a', 0), seen('a', 0), seen('a', 0)], { today: D0 + 10 });
    expect(list[0]!.size).toBe(1);
  });
});

describe('days that have not happened yet', () => {
  it('reports null rather than zero', () => {
    // A cohort that joined yesterday has not failed to return on day 7. It has
    // not reached day 7.
    const list = cohorts([seen('a', 0)], { today: D0 + 1 });
    expect(list[0]!.returnBps[1]).toBe(0);
    expect(list[0]!.returnBps[2]).toBeNull();
    expect(list[0]!.returnBps[7]).toBeNull();
  });

  it('fills in as the days arrive', () => {
    expect(cohorts([seen('a', 0)], { today: D0 + 7 })[0]!.returnBps[7]).toBe(0);
  });
});

describe('activation', () => {
  it('counts wallets that ever traded', () => {
    const list = cohorts([seen('a', 0, true), seen('b', 0), seen('c', 0)], { today: D0 + 10 });
    expect(list[0]!.activated).toBe(1);
  });

  it('counts a wallet that traded on a later day', () => {
    const list = cohorts([seen('a', 0), seen('a', 2, true)], { today: D0 + 10 });
    expect(list[0]!.activated).toBe(1);
  });
});

describe('the headline numbers', () => {
  it('averages over cohorts weighted by size', () => {
    const activity = [
      // Ten joined on day 0, five came back on day 1.
      ...Array.from({ length: 10 }, (_, i) => seen(`a${i}`, 0)),
      ...Array.from({ length: 5 }, (_, i) => seen(`a${i}`, 1)),
      // Two joined on day 1, both came back on day 2.
      seen('b0', 1),
      seen('b1', 1),
      seen('b0', 2),
      seen('b1', 2),
    ];
    const summary = summarize(cohorts(activity, { today: D0 + 10 }), D0 + 10);

    // 5 of 10 and 2 of 2, weighted: 7 of 12.
    expect(summary.d1Bps).toBe(5_833);
  });

  it('leaves an immature cohort out of a day-7 figure', () => {
    // Including a cohort that joined yesterday drags the number toward zero
    // and calls it churn, when nobody has had the chance to come back.
    const activity = [seen('old', 0), seen('old', 7), seen('new', 9)];
    const summary = summarize(cohorts(activity, { today: D0 + 9 }), D0 + 9);

    expect(summary.d7Bps).toBe(10_000);
    expect(summary.maturedCohorts).toBe(1);
  });

  it('reports null when no cohort has reached the day', () => {
    const summary = summarize(cohorts([seen('a', 0)], { today: D0 }), D0);
    expect(summary.d7Bps).toBeNull();
    expect(summary.maturedCohorts).toBe(0);
  });

  it('reports activation across everybody', () => {
    const summary = summarize(
      cohorts([seen('a', 0, true), seen('b', 0), seen('c', 1, true), seen('d', 1)], {
        today: D0 + 10,
      }),
      D0 + 10,
    );
    expect(summary.wallets).toBe(4);
    expect(summary.activated).toBe(2);
    expect(summary.activationBps).toBe(5_000);
  });

  it('says nothing about an empty product', () => {
    const summary = summarize(cohorts([], { today: D0 }), D0);
    expect(summary.wallets).toBe(0);
    expect(summary.activationBps).toBeNull();
    expect(summary.d1Bps).toBeNull();
  });
});
