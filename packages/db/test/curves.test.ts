import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import { recordLaunches, type Launch } from '../src/launches';
import {
  INITIAL_REAL_TOKEN_RESERVES,
  bondedLaunches,
  bondingLaunches,
  curveStatesFor,
  curvesToRefresh,
  newLaunches,
  progressBpsFor,
  recordCurveStates,
} from '../src/curves';

/**
 * The three lanes.
 *
 * Which lane a token is in decides where a trader looks for it, so the rules
 * that sort them get tested against the boundaries rather than the middle.
 */

const CREATOR = '9oNfewPW6KSxbKbTUCQ3g7tc2gViCEYijc6TbDaumwg1';
const NOW = 1_786_278_374_000;
/** Unix seconds, matching what the launch event carries. */
const LAUNCHED = 1_786_271_082;

let db: Client;

function mintFor(index: number): string {
  return `${String(index).padStart(4, '0')}yj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump`;
}

function launch(index: number, overrides: Partial<Launch> = {}): Omit<Launch, 'firstSeenAt'> {
  return {
    mint: mintFor(index),
    bondingCurve: `${String(index).padStart(4, '0')}BR39zwYtUuXQFLbShSsVKkEG6ti5Eup3zUdopiegi`,
    creator: CREATOR,
    name: `token ${index}`,
    symbol: `T${index}`,
    uri: 'https://ipfs.io/ipfs/bafkreice4t5tto76n54rks4t7zqbzflkf3ztza36m7lalmksog',
    launchedAt: LAUNCHED + index,
    slot: 438_197_000 + index,
    ...overrides,
  };
}

/** A curve with `bps` basis points of its tokens sold. */
function atProgress(index: number, bps: number, complete = false) {
  const sold = (INITIAL_REAL_TOKEN_RESERVES * BigInt(bps)) / 10_000n;
  return {
    mint: mintFor(index),
    realSolReserves: BigInt(bps) * 1_000_000n,
    realTokenReserves: complete ? 0n : INITIAL_REAL_TOKEN_RESERVES - sold,
    // A graduated curve zeroes everything, which is what makes keeping the
    // last real price worth testing.
    virtualSolReserves: complete ? 0n : 30_000_000_000n + BigInt(bps) * 1_000_000n,
    virtualTokenReserves: complete ? 0n : 1_073_000_000_000_000n - sold,
    complete,
  };
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
});

describe('progress', () => {
  it('reads zero for a curve nobody has bought from', () => {
    expect(progressBpsFor(INITIAL_REAL_TOKEN_RESERVES, false)).toBe(0);
  });

  it('reads half when half the tokens are gone', () => {
    expect(progressBpsFor(INITIAL_REAL_TOKEN_RESERVES / 2n, false)).toBe(5_000);
  });

  it('reads full for a graduated curve whatever its reserves say', () => {
    // On graduation every reserve field is zeroed. Computing from those would
    // report a token that just succeeded as being at zero progress, which is
    // the exact inverse of the truth.
    expect(progressBpsFor(0n, true)).toBe(10_000);
    expect(progressBpsFor(INITIAL_REAL_TOKEN_RESERVES, true)).toBe(10_000);
  });

  it('never exceeds the range the column accepts', () => {
    // A curve seeded differently by a future program version must not be able
    // to write a value the CHECK constraint rejects.
    expect(progressBpsFor(INITIAL_REAL_TOKEN_RESERVES * 2n, false)).toBe(0);
    expect(progressBpsFor(0n, false)).toBe(10_000);
  });
});

describe('the lanes', () => {
  beforeEach(async () => {
    await recordLaunches(db, [launch(1), launch(2), launch(3), launch(4)], NOW);
  });

  it('puts a fresh token in new and nowhere else', async () => {
    await recordCurveStates(db, [atProgress(1, 200)], NOW);

    expect((await newLaunches(db, 10)).map((row) => row.mint)).toContain(mintFor(1));
    expect(await bondingLaunches(db, 5_000, 10)).toEqual([]);
    expect(await bondedLaunches(db, 10)).toEqual([]);
  });

  it('keeps a launch with no curve reading in the new lane', async () => {
    // A token that launched seconds ago has no curve row yet because nothing
    // has read its account. Dropping it would make the lane people watch the
    // emptiest one.
    const fresh = await newLaunches(db, 10);
    expect(fresh).toHaveLength(4);
    expect(fresh[0]?.curve).toBeNull();
  });

  it('moves a token into bonding once it passes the floor', async () => {
    await recordCurveStates(db, [atProgress(2, 6_000)], NOW);

    const bonding = await bondingLaunches(db, 5_000, 10);
    expect(bonding.map((row) => row.mint)).toEqual([mintFor(2)]);
    expect(bonding[0]?.curve?.progressBps).toBe(6_000);
  });

  it('holds a token below the floor out of the bonding lane', async () => {
    await recordCurveStates(db, [atProgress(2, 4_999)], NOW);
    expect(await bondingLaunches(db, 5_000, 10)).toEqual([]);
  });

  it('orders bonding by how close to graduating, not by age', async () => {
    await recordCurveStates(
      db,
      [atProgress(1, 5_100), atProgress(2, 9_400), atProgress(3, 7_200)],
      NOW,
    );

    expect((await bondingLaunches(db, 5_000, 10)).map((row) => row.mint)).toEqual([
      mintFor(2),
      mintFor(3),
      mintFor(1),
    ]);
  });

  it('takes a graduated token out of the other two lanes', async () => {
    await recordCurveStates(db, [atProgress(3, 10_000, true)], NOW);

    expect((await bondedLaunches(db, 10)).map((row) => row.mint)).toEqual([mintFor(3)]);
    expect((await newLaunches(db, 10)).map((row) => row.mint)).not.toContain(mintFor(3));
    expect((await bondingLaunches(db, 5_000, 10)).map((row) => row.mint)).not.toContain(
      mintFor(3),
    );
  });

  it('keeps the last price when a curve graduates and zeroes its reserves', async () => {
    await recordCurveStates(db, [atProgress(1, 9_000)], NOW);
    const priced = (await curveStatesFor(db, [mintFor(1)])).get(mintFor(1));
    expect(priced?.virtualSolReserves).toBeGreaterThan(0n);

    await recordCurveStates(db, [atProgress(1, 10_000, true)], NOW + 1_000);

    const after = (await curveStatesFor(db, [mintFor(1)])).get(mintFor(1));
    expect(after?.complete).toBe(true);
    // Blanking the price at the moment a token succeeds is the worst possible
    // time to lose the number.
    expect(after?.virtualSolReserves).toBe(priced?.virtualSolReserves);
    expect(after?.virtualTokenReserves).toBe(priced?.virtualTokenReserves);
  });

  it('replaces a state rather than accumulating rows', async () => {
    await recordCurveStates(db, [atProgress(1, 1_000)], NOW);
    await recordCurveStates(db, [atProgress(1, 8_000)], NOW + 1_000);

    const states = await curveStatesFor(db, [mintFor(1)]);
    expect(states.size).toBe(1);
    expect(states.get(mintFor(1))?.progressBps).toBe(8_000);
    expect(states.get(mintFor(1))?.updatedAt).toBe(NOW + 1_000);
  });
});

describe('choosing what to refresh', () => {
  beforeEach(async () => {
    await recordLaunches(db, [launch(1), launch(2), launch(3)], NOW);
  });

  it('reads the never-read before the already-read', async () => {
    await recordCurveStates(db, [atProgress(1, 100)], NOW);

    const next = await curvesToRefresh(db, 10, 0);
    // 2 and 3 have never been read at all, so they come before 1.
    expect(next.slice(0, 2).map((row) => row.mint)).not.toContain(mintFor(1));
    expect(next.at(-1)?.mint).toBe(mintFor(1));
  });

  it('reads the stalest first among those already read', async () => {
    await recordCurveStates(db, [atProgress(1, 100)], NOW + 5_000);
    await recordCurveStates(db, [atProgress(2, 100)], NOW + 1_000);
    await recordCurveStates(db, [atProgress(3, 100)], NOW + 9_000);

    expect((await curvesToRefresh(db, 10, 0)).map((row) => row.mint)).toEqual([
      mintFor(2),
      mintFor(1),
      mintFor(3),
    ]);
  });

  it('stops reading a curve once it has graduated', async () => {
    // Graduation is terminal. Re-reading it spends a call to learn nothing,
    // and those calls are the budget the other lanes run on.
    await recordCurveStates(db, [atProgress(1, 10_000, true)], NOW);

    expect((await curvesToRefresh(db, 10, 0)).map((row) => row.mint)).not.toContain(mintFor(1));
  });

  it('stops watching launches older than the window', async () => {
    expect(await curvesToRefresh(db, 10, LAUNCHED + 100)).toEqual([]);
    expect(await curvesToRefresh(db, 10, LAUNCHED)).toHaveLength(3);
  });

  it('carries the curve address, since that is the account to read', async () => {
    const next = await curvesToRefresh(db, 1, 0);
    expect(next[0]?.bondingCurve).toBe(launch(3).bondingCurve);
  });
});
