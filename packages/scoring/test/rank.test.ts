import { describe, expect, it } from 'vitest';
import { compareStandings, placeOf, rankSeason, returnBps, type Standing } from '../src/rank';

const SOL = 1_000_000_000n;
const START = 10n * SOL;

function trader(name: string, finalEquity: bigint, overrides: Partial<Standing> = {}): Standing {
  return {
    trader: name,
    enteredAt: 1_000,
    startingBalance: START,
    finalEquity,
    tradeCount: 5,
    ...overrides,
  };
}

describe('return', () => {
  it('is zero when nothing changed', () => {
    expect(returnBps(START, START)).toBe(0);
  });

  it('is positive on a gain', () => {
    expect(returnBps(START, 15n * SOL)).toBe(5_000);
  });

  it('is negative on a loss', () => {
    expect(returnBps(START, 5n * SOL)).toBe(-5_000);
  });

  it('truncates toward zero in both directions', () => {
    // A trader is never shown a gain they have not quite made, and a loss is
    // never rounded into a deeper one.
    expect(returnBps(START, START + 1n)).toBe(0);
    expect(returnBps(START, START - 1n)).toBe(0);
  });

  it('handles a wipeout', () => {
    expect(returnBps(START, 0n)).toBe(-10_000);
  });

  it('says nothing about an account that started with nothing', () => {
    expect(returnBps(0n, SOL)).toBe(0);
  });
});

describe('ordering', () => {
  it('puts the highest return first', () => {
    const ranked = rankSeason([
      trader('b', 12n * SOL),
      trader('a', 20n * SOL),
      trader('c', 9n * SOL),
    ]);
    expect(ranked.map((standing) => standing.trader)).toEqual(['a', 'b', 'c']);
    expect(ranked.map((standing) => standing.rank)).toEqual([1, 2, 3]);
  });

  it('ranks a season where everybody lost', () => {
    // An ordinary season. The least bad still wins.
    const ranked = rankSeason([trader('a', 2n * SOL), trader('b', 8n * SOL)]);
    expect(ranked[0]!.trader).toBe('b');
    expect(ranked[0]!.returnBps).toBe(-2_000);
  });

  it('never reports two firsts', () => {
    // A ranking that ties cannot pay one of them.
    const ranked = rankSeason([
      trader('b', 12n * SOL),
      trader('a', 12n * SOL),
      trader('c', 12n * SOL),
    ]);
    expect(ranked.map((standing) => standing.rank)).toEqual([1, 2, 3]);
  });

  it('does not spend a tie-break on a rounding artefact', () => {
    // Both round to the same basis point; one genuinely finished ahead.
    const ranked = rankSeason([
      trader('late', START + 1n, { enteredAt: 5_000 }),
      trader('early', START + 2n, { enteredAt: 1_000 }),
    ]);
    expect(ranked[0]!.trader).toBe('early');

    const reversed = rankSeason([
      trader('early', START + 1n, { enteredAt: 1_000 }),
      trader('late', START + 2n, { enteredAt: 5_000 }),
    ]);
    expect(reversed[0]!.trader).toBe('late');
  });

  it('breaks a real tie by who entered first', () => {
    const ranked = rankSeason([
      trader('later', 12n * SOL, { enteredAt: 9_000 }),
      trader('earlier', 12n * SOL, { enteredAt: 1_000 }),
    ]);
    expect(ranked[0]!.trader).toBe('earlier');
  });

  it('falls back to the key when even that ties', () => {
    // Arbitrary, and meant to be. It exists so the ordering is total.
    const ranked = rankSeason([
      trader('zzz', 12n * SOL, { enteredAt: 1_000 }),
      trader('aaa', 12n * SOL, { enteredAt: 1_000 }),
    ]);
    expect(ranked.map((standing) => standing.trader)).toEqual(['aaa', 'zzz']);
  });

  it('gives the same order however the input arrived', () => {
    const standings = [
      trader('a', 12n * SOL, { enteredAt: 3 }),
      trader('b', 12n * SOL, { enteredAt: 1 }),
      trader('c', 20n * SOL, { enteredAt: 2 }),
      trader('d', 12n * SOL, { enteredAt: 2 }),
    ];
    const forward = rankSeason(standings).map((standing) => standing.trader);
    const backward = rankSeason([...standings].reverse()).map((standing) => standing.trader);
    expect(backward).toEqual(forward);
  });

  it('does not modify what it was given', () => {
    const standings = [trader('b', 12n * SOL), trader('a', 20n * SOL)];
    rankSeason(standings);
    expect(standings[0]!.trader).toBe('b');
  });

  it('ranks a season of one', () => {
    expect(rankSeason([trader('a', 12n * SOL)])[0]!.rank).toBe(1);
  });

  it('ranks an empty season', () => {
    expect(rankSeason([])).toEqual([]);
  });
});

describe('the comparison is the published rule', () => {
  it('is runnable by anybody holding the same standings', () => {
    // The point of exporting it. A rule nobody can run is a claim.
    const standings = [trader('b', 12n * SOL), trader('a', 20n * SOL), trader('c', 9n * SOL)];
    const theirs = [...standings].sort(compareStandings).map((standing) => standing.trader);
    const ours = rankSeason(standings).map((standing) => standing.trader);
    expect(theirs).toEqual(ours);
  });

  it('is antisymmetric', () => {
    const left = trader('a', 12n * SOL, { enteredAt: 1 });
    const right = trader('b', 20n * SOL, { enteredAt: 2 });
    expect(Math.sign(compareStandings(left, right))).toBe(-Math.sign(compareStandings(right, left)));
  });

  it('calls a standing equal to itself', () => {
    const only = trader('a', 12n * SOL);
    expect(compareStandings(only, only)).toBe(0);
  });
});

describe('finding a trader', () => {
  it('reports where they placed', () => {
    const ranked = rankSeason([trader('a', 20n * SOL), trader('b', 12n * SOL)]);
    expect(placeOf(ranked, 'b')?.rank).toBe(2);
  });

  it('reports nothing for somebody who was not in it', () => {
    expect(placeOf(rankSeason([trader('a', 20n * SOL)]), 'nobody')).toBeNull();
  });
});
