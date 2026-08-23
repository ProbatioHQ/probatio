import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The board's two clocks.
 *
 * The database and the domain are in milliseconds and the broadcast is in
 * seconds, and mixing them is silent in a way nothing else here is: seconds
 * compared against milliseconds makes every fill ever made look like one from
 * the last day, and a season that ends next week look like it ends in fifty
 * thousand years. Nothing throws, nothing logs, and the board reads as though
 * it were working.
 *
 * These are the assertions that fail when somebody forgets which unit they are
 * holding.
 */

const NOW_MS = 1_787_000_000_000;
const DAY_MS = 86_400_000;

/* What the fake database was asked, so a unit can be caught in the query. */
let sqlSeen: { sql: string; args: unknown[] }[] = [];
let counts: Record<string, number> = {};
let trades: unknown[] = [];
let seasonRow: Record<string, unknown> | null = null;
let standings: unknown[] = [];
let driftRows: unknown[] = [];

vi.mock('../db', () => ({
  db: async () => ({
    execute: async (query: string | { sql: string; args: unknown[] }) => {
      const sql = typeof query === 'string' ? query : query.sql;
      const args = typeof query === 'string' ? [] : query.args;
      sqlSeen.push({ sql, args });
      const table = /FROM (\w+)/.exec(sql)?.[1] ?? '';
      const windowed = sql.includes('created_at >=');
      const key = windowed ? 'tradesToday' : table;
      return { rows: [{ n: counts[key] ?? 0 }] };
    },
  }),
}));

/* Counted, so a test can tell one build from two. */
let builds = 0;
let hangFirstBuild = false;

vi.mock('@probatio/db', () => ({
  recentTrades: async () => {
    builds += 1;
    // A source that never answers, which is the failure the guard is for.
    if (hangFirstBuild && builds === 1) await new Promise(() => undefined);
    return trades;
  },
  recentDrift: async () => driftRows,
  suspendedTokens: async () => [],
  /*
   * Modelled on the real one rather than simplified.
   *
   * It hands back the running season, then the next one due, then the last one
   * held, and it decides on a millisecond clock. A stub that returned null
   * unless a season was running would have let the board's own handling of
   * "not started yet" go untested, which is the case it gets wrong.
   */
  currentRankedSeason: async (_c: unknown, now: number) => {
    if (!seasonRow) return null;
    void now;
    return seasonRow;
  },
}));

vi.mock('../explore', () => ({ movers: async () => ({ movers: [] }) }));
vi.mock('../leaderboard', () => ({
  seasonBoard: async () => ({ standings, markedAt: NOW_MS, unpriced: [] }),
}));
vi.mock('../autonomy', () => ({ autonomy: async () => ({ latest: null, history: [] }) }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  sqlSeen = [];
  builds = 0;
  hangFirstBuild = false;
  counts = {};
  trades = [];
  seasonRow = null;
  standings = [];
  driftRows = [];
});

afterEach(() => vi.useRealTimers());

describe('the day window', () => {
  /*
   * The one that was wrong. `created_at` is stamped with `Date.now()`, so a
   * cutoff in seconds is about a thousand times too small and every row in the
   * table is newer than it.
   */
  it('asks for the last day in the same unit the column is stored in', async () => {
    const { streamBoard } = await import('../livestream');
    await streamBoard();

    const windowed = sqlSeen.find((q) => q.sql.includes('created_at >='));
    expect(windowed).toBeDefined();
    expect(windowed!.args[0]).toBe(NOW_MS - DAY_MS);
    // A seconds cutoff would be six digits shorter, and every fill would pass.
    expect(Number(windowed!.args[0])).toBeGreaterThan(1e12);
  });

  it('reports the windowed count rather than the total', async () => {
    counts = { users: 5, accounts: 6, trades: 900, tradesToday: 7 };
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();

    expect(board.vitals.fills).toBe(900);
    expect(board.vitals.fillsToday).toBe(7);
  });
});

describe('the season', () => {
  const ENDS_MS = NOW_MS + 3 * DAY_MS;

  beforeEach(() => {
    seasonRow = {
      id: 1,
      ordinal: 1,
      name: 'Season 1',
      startsAt: NOW_MS - DAY_MS,
      endsAt: ENDS_MS,
    };
  });

  it('is found at all, which needs a millisecond clock', async () => {
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();
    expect(board.season?.name).toBe('Season 1');
    expect(board.season?.state).toBe('running');
  });

  /*
   * The card must not count down over a season that has finished, and must not
   * go silent between one and the next.
   */
  it('says a finished season has finished', async () => {
    seasonRow = { ...seasonRow!, startsAt: NOW_MS - 9 * DAY_MS, endsAt: NOW_MS - DAY_MS };
    const { streamBoard } = await import('../livestream');
    expect((await streamBoard()).season?.state).toBe('ended');
  });

  it('says a season that has not started is still to come', async () => {
    seasonRow = { ...seasonRow!, startsAt: NOW_MS + DAY_MS, endsAt: NOW_MS + 9 * DAY_MS };
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();

    // The reader hands back a pending season; the board must not call it live.
    expect(board.season?.state).toBe('upcoming');
    expect(board.season?.startsAt).toBe(Math.floor((NOW_MS + DAY_MS) / 1000));
  });

  /*
   * The case this reader was swapped in for: entry has closed, everybody is
   * still trading, and the old one returned null so the board said no season
   * was open while one was running.
   */
  it('still reports a season whose entry window has closed', async () => {
    seasonRow = {
      ...seasonRow!,
      startsAt: NOW_MS - 6 * DAY_MS,
      endsAt: NOW_MS + DAY_MS,
      entryClosesAt: NOW_MS - 5 * DAY_MS,
    };
    const { streamBoard } = await import('../livestream');
    expect((await streamBoard()).season?.state).toBe('running');
  });

  /*
   * The countdown is drawn from this against the board's own clock, so it has
   * to leave here in seconds. In milliseconds a three day season reads as about
   * fifty thousand years.
   */
  it('hands the end back in seconds, not milliseconds', async () => {
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();

    expect(board.season?.endsAt).toBe(Math.floor(ENDS_MS / 1000));
    expect(board.season!.endsAt! - board.at).toBe(3 * 86_400);
  });
});

describe('timestamps leaving the boundary', () => {
  it('converts a fill from the clock it was stamped with', async () => {
    trades = [{
      pubkey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      mint: 'So11111111111111111111111111111111111111112',
      side: 'buy', solAmount: '1000000000', priceImpactBps: 40, latencyMs: 600,
      leafHash: 'abcdef0123456789', createdAt: NOW_MS - 30_000, poolSource: 'pumpfun-curve',
    }];
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();

    expect(board.tape[0]!.at).toBe(Math.floor((NOW_MS - 30_000) / 1000));
    // Thirty seconds ago on the board's clock, not thirty thousand.
    expect(board.at - board.tape[0]!.at).toBe(30);
  });

  it('converts the watchdog, which also records milliseconds', async () => {
    driftRows = [{ mint: 'm', medianAbsBps: 12, observedAt: NOW_MS - 600_000 }];
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();

    expect(board.drift.at).toBe(Math.floor((NOW_MS - 600_000) / 1000));
    expect(board.at - board.drift.at!).toBe(600);
  });

  it('says nothing rather than zero when the watchdog has not run', async () => {
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();
    expect(board.drift.at).toBeNull();
    expect(board.drift.worstBps).toBeNull();
  });
});

/**
 * A refresh that never finishes.
 *
 * Every network call underneath is bounded, so this should not happen. The
 * reason it is guarded anyway is what happens if it does: the slot holding the
 * in-flight build is never released, no later refresh can start, and the board
 * shows its last numbers until somebody redeploys. It degrades honestly, the
 * dot goes amber and the header counts the days, but it never recovers by
 * itself, and this thing is meant to run unattended for months.
 */
describe('a build that wedges', () => {
  it('does not start a second build while the first is still going', async () => {
    const { streamBoard } = await import('../livestream');
    await Promise.all([streamBoard(), streamBoard(), streamBoard()]);
    expect(builds).toBe(1);
  });

  it('is abandoned once it has run past all reason, so the next poll can try', async () => {
    hangFirstBuild = true;
    const { streamBoard } = await import('../livestream');

    // Nothing to show and nothing coming: the cold path gives up and hands back
    // an empty board rather than holding the request open.
    const first = streamBoard();
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await first).vitals.fills).toBe(0);
    expect(builds).toBe(1);

    // Still inside the window, so the wedged build is still considered current.
    vi.setSystemTime(NOW_MS + 60_000);
    void streamBoard();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(builds).toBe(1);

    // Past it, and a fresh build starts even though the first never finished.
    vi.setSystemTime(NOW_MS + 91_000);
    counts = { users: 3, accounts: 3, trades: 12, tradesToday: 4 };
    const recovered = await streamBoard();

    expect(builds).toBe(2);
    expect(recovered.vitals.fills).toBe(12);
  });
});

/**
 * The difference between nothing recorded and nothing read.
 *
 * The cold start hands back a board so a request does not hang for a minute,
 * and every figure on it is zero. Rendered plainly that reads as a site with no
 * traders and no fills under a green light, which is a confident lie on a
 * screen a camera is pointed at.
 */
describe('a board nobody has filled in yet', () => {
  it('marks itself as not read, so the view can tell', async () => {
    hangFirstBuild = true;
    const { streamBoard } = await import('../livestream');

    const cold = streamBoard();
    await vi.advanceTimersByTimeAsync(4_000);
    const board = await cold;

    expect(board.ready).toBe(false);
    expect(board.vitals.fills).toBe(0);
  });

  it('marks a real one as read', async () => {
    counts = { users: 2, accounts: 2, trades: 8, tradesToday: 1 };
    const { streamBoard } = await import('../livestream');
    const board = await streamBoard();

    expect(board.ready).toBe(true);
    expect(board.vitals.fills).toBe(8);
  });
});
