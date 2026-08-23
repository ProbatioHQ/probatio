import { streamBoard } from '@/lib/livestream';

/**
 * Everything the broadcast board draws.
 *
 * Public and unauthenticated, because every figure on it is already public: the
 * leaderboard, the movers, the fill tape and the audit are all readable pages
 * on this site. A stream nobody can check against the source is a stream that
 * may as well be a video file.
 *
 * Deliberately not rate limited. The one caller is a browser in a capture rig
 * polling forever, and cutting it off would blank a broadcast rather than
 * protect anything: the work behind it is cached for twelve seconds and served
 * from memory to every caller, so a thousand viewers cost what one does.
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const board = await streamBoard();

  /*
   * The clock, stamped now, separately from the board's own timestamp.
   *
   * `board.at` is when the figures were read, and the board is cached for
   * twelve seconds, so it runs between four and eighteen seconds behind real
   * time and sawtooths as the cache turns over. The header clock was seeded
   * from it and inherited all of that: a wall clock on a broadcast that lags by
   * a variable amount and occasionally steps backwards, which anybody with a
   * watch can see is wrong.
   *
   * Two different questions, so two numbers. This one says what time it is. The
   * board's own says how old the figures are, which is what the LIVE indicator
   * is measured against and must keep using.
   */
  return Response.json(
    {
      ...board,
      now: Math.floor(Date.now() / 1000),
      /*
       * Which build answered. A broadcast holds this page open for weeks and
       * would otherwise keep showing whatever the board said on the day it was
       * opened, including anything since corrected.
       */
      build: process.env['RAILWAY_GIT_COMMIT_SHA']?.slice(0, 7) ?? 'local',
    },
    {
      headers: {
        // Never cached anywhere. The assembler already dedupes the work behind
        // this, so a second layer would only serve a stale clock.
        'cache-control': 'no-store',
      },
    },
  );
}
