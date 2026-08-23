import 'server-only';
import { recentDrift, recentTrades, suspendedTokens, currentRankedSeason } from '@probatio/db';
import { ENGINE_VERSION } from '@probatio/sim';
import { db } from './db';
import { movers } from './explore';
import { seasonBoard } from './leaderboard';
import { autonomy, type Autonomy } from './autonomy';

/**
 * Everything the broadcast shows, in one read.
 *
 * A stream is watched in ten second glances by somebody deciding whether this
 * is a real thing, so the board has to answer "what is this" and "is it alive"
 * in every frame. That means one payload rather than seven endpoints: the cards
 * rotate on the client and a card that arrives late is a card that is blank at
 * the moment somebody looks at it.
 *
 * Nothing here is computed for the broadcast. Every number is the same number
 * the site's own pages read, from the same readers, which is the only way a
 * stream stays honest when nobody is checking it against anything.
 */

export interface Vitals {
  readonly traders: number;
  readonly accounts: number;
  readonly fills: number;
  readonly fillsToday: number;
  readonly engineVersion: number;
  /** Seconds this process has been serving. */
  readonly uptime: number;
}

export interface TapeFill {
  readonly trader: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly sol: string;
  readonly impactBps: number;
  readonly latencyMs: number;
  readonly seal: string;
  readonly at: number;
}

export interface StreamMover {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly image: string | null;
  readonly marketCapUsd: number;
  readonly changeH1: number | null;
  /**
   * Closes over the last few hours, for the line drawn on the card.
   *
   * The board was dropping this and showing a percentage instead, which is the
   * same number every other site shows and says nothing about the shape it took
   * getting there. The explore board has drawn it all along.
   */
  readonly spark: readonly number[];
}

export interface StreamSeason {
  readonly name: string;
  /**
   * Which of the three things a season can be, since a board has to say.
   *
   * A card that reads "3d left" over a season that finished last week is worse
   * than one that says nothing, and between seasons the honest answer is when
   * the next one opens rather than silence.
   */
  readonly state: 'running' | 'upcoming' | 'ended';
  readonly entrants: number;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly top: readonly { rank: number; trader: string; returnBps: number }[];
}

export interface StreamDrift {
  readonly checked: number;
  /** The worst gap seen between the engine and a real fill, in basis points. */
  readonly worstBps: number | null;
  readonly suspended: number;
  readonly at: number | null;
  /**
   * The recent observations in order, oldest first, in basis points.
   *
   * Four numbers and a lot of black was what this card had, and none of the
   * four say whether the engine is drifting or holding. A line does, and the
   * watchdog has been recording one all along.
   */
  readonly series: readonly number[];
}

export interface StreamBoard {
  /**
   * Whether anything here has actually been read yet.
   *
   * A cold start hands back a board before the first build has finished, so
   * that a caller waits four seconds rather than fifty. Every figure on it is
   * zero, and zero is a number: rendered plainly it says this site has no
   * traders, no accounts and no fills, which is a confident lie on a screen
   * pointed at by a camera. The flag is how the board says it does not know
   * yet, so the difference between nothing recorded and nothing read stays
   * visible.
   */
  readonly ready: boolean;
  readonly at: number;
  readonly vitals: Vitals;
  readonly movers: readonly StreamMover[];
  readonly tape: readonly TapeFill[];
  readonly season: StreamSeason | null;
  readonly drift: StreamDrift;
  readonly autonomy: Autonomy;
}

const STARTED = Date.now();

/*
 * Two clocks, and everything that reads a stored timestamp has to know which.
 *
 * The database and the domain are in milliseconds: the trade route stamps a
 * fill with `Date.now()`, a season's schedule is built from `durationMs`, and
 * the drift watchdog records `Date.now()`. The board is in seconds, because a
 * broadcast counts down in seconds and a payload full of thirteen digit numbers
 * is a payload somebody divides by a thousand in the wrong place eventually.
 *
 * So the conversion happens here, once, at the boundary. Every domain call gets
 * milliseconds and every figure leaving this file is seconds. Written down
 * because getting it wrong is silent: seconds compared against milliseconds
 * makes every fill look like it happened today and every season look like it
 * ends in fifty thousand years.
 */
const secs = (ms: number): number => Math.floor(ms / 1000);

/*
 * Cached, because a broadcast polls forever.
 *
 * Twelve seconds. Long enough that a stream running for a month is not a second
 * traffic source against the database, short enough that the tape still reads
 * as a tape. The board is the same for every viewer, so one read serves all of
 * them.
 */
const CACHE_MS = 12_000;

/**
 * How long a caller will ever wait, and only when there is nothing to show yet.
 *
 * Once a board exists, nobody waits at all.
 */
const COLD_MS = 4_000;

/**
 * How long a refresh may be in flight before it stops counting as in flight.
 *
 * Every network call underneath is bounded, so a build should always settle.
 * But "should" is doing a lot of work over a run measured in months, and the
 * consequence of being wrong is specific: a refresh that never settles is never
 * cleared, so no later refresh can start, and the board freezes on its last
 * numbers until somebody redeploys it. It would degrade honestly, the dot goes
 * amber and the header counts the days, but it would never recover on its own.
 *
 * Ninety seconds, comfortably past the slowest legitimate build measured, after
 * which a stuck one is abandoned and the next poll starts a fresh one. The old
 * one is not cancelled; if it does eventually land it fills the cache, which is
 * better than nothing and no worse than the alternative.
 */
const STUCK_MS = 90_000;

let cache: { board: StreamBoard; expiresAt: number } | null = null;
/** The refresh in flight, so a hundred pollers cause one read and not a hundred. */
let refreshing: Promise<StreamBoard> | null = null;
let refreshStartedAt = 0;

/** A wallet as a stream can show it: enough to tell two traders apart. */
function shorten(pubkey: string): string {
  return pubkey.length > 10 ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}` : pubkey;
}

async function counts(nowMs: number): Promise<Pick<Vitals, 'traders' | 'accounts' | 'fills' | 'fillsToday'>> {
  const client = await db();
  // Milliseconds, matching `created_at`. In seconds this compared 1.7e9 against
  // 1.7e12 and every fill ever made counted as one from the last day.
  const dayAgo = nowMs - 86_400_000;
  const [users, accounts, fills, today] = await Promise.all([
    client.execute('SELECT COUNT(*) AS n FROM users'),
    client.execute('SELECT COUNT(*) AS n FROM accounts'),
    client.execute('SELECT COUNT(*) AS n FROM trades'),
    client.execute({ sql: 'SELECT COUNT(*) AS n FROM trades WHERE created_at >= ?', args: [dayAgo] }),
  ]);
  const n = (r: { rows: unknown[] }) => Number((r.rows[0] as Record<string, unknown>)['n'] ?? 0);
  return { traders: n(users), accounts: n(accounts), fills: n(fills), fillsToday: n(today) };
}

/**
 * The engine measured against reality, as the watchdog last left it.
 *
 * Read rather than run. `drift-watch` does the measuring on its own timer and
 * each cycle costs real RPC calls, so a stream that triggered one every twelve
 * seconds would be a stream that exhausts the month's credits by Tuesday. This
 * shows the verdict somebody else already reached.
 */
async function drift(): Promise<StreamDrift> {
  const client = await db();
  try {
    const [rows, suspended] = await Promise.all([
      recentDrift(client, 50),
      suspendedTokens(client),
    ]);

    let worst: number | null = null;
    let at: number | null = null;
    for (const row of rows) {
      const bps = Math.abs(Number(row.medianAbsBps ?? 0));
      if (Number.isFinite(bps) && (worst === null || bps > worst)) worst = bps;
      // `observed_at` is written with `Date.now()`, so it is milliseconds too.
      const when = Number(row.observedAt ?? 0);
      if (Number.isFinite(when) && when > 0 && (at === null || when > at)) at = secs(when);
    }

    // Oldest first, which is the direction a chart is read in.
    const series = rows
      .slice(0, 40)
      .map((row) => Math.abs(Number(row.medianAbsBps ?? 0)))
      .filter((v) => Number.isFinite(v))
      .reverse();

    return { checked: rows.length, worstBps: worst, suspended: suspended.length, at, series };
  } catch {
    // A board that cannot read the watchdog says nothing rather than "fine".
    return { checked: 0, worstBps: null, suspended: 0, at: null, series: [] };
  }
}

async function season(nowMs: number): Promise<StreamSeason | null> {
  const client = await db();
  /*
   * `currentRankedSeason`, not `openRankedSeason`.
   *
   * The second means "a season you can still enter": it requires
   * `entry_closes_at > now`, so a season in its final week, entry long closed
   * and everybody still trading, comes back null. The board would have said no
   * ranked season is open while one was running, which is the one thing a
   * status board must not do. This one answers the question actually being
   * asked, and falls back to the next season due and then the last one held.
   *
   * Milliseconds, because it compares against `starts_at` and `ends_at`.
   */
  const open = await currentRankedSeason(client, nowMs);
  if (!open) return null;

  const started = open.startsAt !== null && open.startsAt <= nowMs;
  const finished = open.endsAt !== null && open.endsAt <= nowMs;
  const state = finished ? 'ended' : started ? 'running' : 'upcoming';

  const board = await seasonBoard(client, open.id, nowMs);
  return {
    name: open.name,
    state,
    entrants: board.standings.length,
    startsAt: open.startsAt === null ? null : secs(open.startsAt),
    endsAt: open.endsAt === null ? null : secs(open.endsAt),
    top: board.standings.slice(0, 5).map((s) => ({
      rank: s.rank,
      trader: shorten(s.trader),
      returnBps: s.returnBps,
    })),
  };
}

/**
 * Hand back what is known now, and go and find out what is true next.
 *
 * Measured before this existed: one request took fifty seconds, because
 * assembling the board awaited every source and marking the leaderboard to
 * market needs a price for every held mint. On a board polling every twelve
 * seconds that is fatal in a way a page is not. A page is opened by somebody
 * willing to wait; this one asks again before the last answer arrived, so
 * requests pile up on each other until nothing lands at all.
 *
 * So a caller never waits for a refresh it did not have to trigger. A board
 * already in hand is served immediately and the refresh happens behind it,
 * which means the worst a slow source can do is make the numbers a cycle old.
 * They were all true when they were read, and the header says how old they are.
 *
 * Only a cold start waits, and only for four seconds, after which it hands back
 * an empty board and lets the poll a moment later pick up the real one. A
 * broadcast that shows nothing for four seconds after a deploy is fine. One
 * that shows nothing for fifty is not.
 */
export async function streamBoard(): Promise<StreamBoard> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.board;

  // A build that has run past all reason is no longer the build in flight.
  if (refreshing && now - refreshStartedAt > STUCK_MS) refreshing = null;

  if (!refreshing) {
    refreshStartedAt = now;
    /*
     * The slot is cleared only by whoever is still holding it.
     *
     * An abandoned build is not cancelled, it is merely no longer waited on, so
     * its `finally` still runs whenever it finally gives up. Clearing the slot
     * unconditionally there would wipe out the replacement that started in the
     * meantime, and the next poll would launch a third build against a second
     * one still running. Comparing identities keeps a straggler from evicting
     * its own successor.
     */
    const mine: Promise<StreamBoard> = build()
      .then((board) => {
        cache = { board, expiresAt: Date.now() + CACHE_MS };
        return board;
      })
      .finally(() => {
        if (refreshing === mine) refreshing = null;
      });
    refreshing = mine;
    // Nobody may be awaiting it, and an unhandled rejection would take the
    // process down. The next cycle tries again.
    mine.catch(() => undefined);
  }

  // Stale, but real. The refresh above will replace it when it lands.
  if (cache) return cache.board;

  const started = refreshing;
  return await Promise.race([
    started,
    new Promise<StreamBoard>((resolve) => {
      setTimeout(() => resolve(empty(secs(now))), COLD_MS).unref?.();
    }),
  ]);
}

/** Nothing known yet, and saying so rather than reporting zeroes. */
function empty(at: number): StreamBoard {
  return {
    ready: false,
    at,
    vitals: { traders: 0, accounts: 0, fills: 0, fillsToday: 0, engineVersion: ENGINE_VERSION, uptime: 0 },
    movers: [],
    tape: [],
    season: null,
    drift: { checked: 0, worstBps: null, suspended: 0, at: null, series: [] },
    autonomy: { latest: null, history: [] },
  };
}

async function build(): Promise<StreamBoard> {
  const now = Date.now();
  const client = await db();
  const seconds = secs(now);

  /*
   * Every source settled independently.
   *
   * The board is seven cards and one of them failing is not a reason to show
   * none: the movers come from an outside index, the season needs a marked
   * leaderboard, and the audit is a file that may not exist yet. A rejection
   * anywhere used to be a blank screen for as long as it lasted.
   */
  const [vitals, board, fills, ranked, engine, checks] = await Promise.allSettled([
    counts(now),
    movers(1, 8, 1),
    recentTrades(client, 24),
    season(now),
    drift(),
    autonomy(),
  ]);

  const vital = vitals.status === 'fulfilled' ? vitals.value
    : { traders: 0, accounts: 0, fills: 0, fillsToday: 0 };

  const result: StreamBoard = {
    ready: true,
    at: seconds,
    vitals: { ...vital, engineVersion: ENGINE_VERSION, uptime: secs(now - STARTED) },
    movers:
      board.status === 'fulfilled'
        ? board.value.movers.slice(0, 8).map((m) => ({
            mint: m.mint,
            name: m.name,
            symbol: m.symbol,
            image: m.image,
            marketCapUsd: m.marketCapUsd,
            changeH1: m.changeH1,
            spark: m.spark,
          }))
        : [],
    tape:
      fills.status === 'fulfilled'
        ? fills.value.map((t) => ({
            trader: shorten(t.pubkey),
            mint: t.mint,
            side: t.side,
            sol: t.solAmount,
            impactBps: t.priceImpactBps,
            latencyMs: t.latencyMs,
            // The first twelve characters are plenty to read off a screen and
            // enough to match against the full one in a record.
            seal: t.leafHash.slice(0, 12),
            at: secs(t.createdAt),
          }))
        : [],
    season: ranked.status === 'fulfilled' ? ranked.value : null,
    drift:
      engine.status === 'fulfilled'
        ? engine.value
        : { checked: 0, worstBps: null, suspended: 0, at: null, series: [] },
    autonomy: checks.status === 'fulfilled' ? checks.value : { latest: null, history: [] },
  };

  return result;
}
