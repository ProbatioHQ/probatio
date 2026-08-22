import type { Client } from '@libsql/client';

/**
 * Real traders, built from swaps this site already reads.
 *
 * The chart backfill walks a pool's history to draw its candles. Every one of
 * those transactions has a payer, and that payer is a real person trading real
 * money on pump.fun. Keeping them costs one insert per swap and turns work
 * already being done into a board of traders worth watching.
 *
 * What this cannot claim: it is not everybody, and it is not a wallet's whole
 * history. Coverage is whatever pools have been walked, which is the tokens
 * people have opened here. A board built on it should say so rather than imply
 * it ranks all of pump.fun.
 */

export interface ObservedSwap {
  readonly signature: string;
  readonly trader: string;
  readonly mint: string;
  readonly isBuy: boolean;
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly slot: number;
  readonly blockTime: number | null;
  /** The pool immediately after this swap: the price a copier would arrive at. */
  readonly solAfter?: string | null;
  readonly tokenAfter?: string | null;
}

/**
 * Record a page of swaps, ignoring any already held.
 *
 * A pool is walked again every time its chart refreshes, so the same swap
 * arrives over and over. `DO NOTHING` on the signature is what stops one trade
 * being counted ten times, and it is why the signature is the primary key
 * rather than an id nobody would look at.
 */
export async function recordObservedSwaps(
  db: Client,
  swaps: readonly ObservedSwap[],
  now: number,
): Promise<number> {
  if (swaps.length === 0) return 0;

  let written = 0;
  // In batches, because a deep walk hands over thousands and one statement per
  // swap is thousands of round trips.
  for (let i = 0; i < swaps.length; i += 100) {
    const batch = swaps.slice(i, i + 100);
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const args = batch.flatMap((swap) => [
      swap.signature,
      swap.trader,
      swap.mint,
      swap.isBuy ? 1 : 0,
      swap.solAmount,
      swap.tokenAmount,
      swap.slot,
      swap.blockTime,
      now,
      swap.solAfter ?? null,
      swap.tokenAfter ?? null,
    ]);
    const result = await db.execute({
      sql: `INSERT INTO observed_swaps
              (signature, trader, mint, is_buy, sol_amount, token_amount, slot, block_time,
               seen_at, sol_after, token_after)
            VALUES ${values}
            ON CONFLICT (signature) DO NOTHING`,
      args,
    });
    written += Number(result.rowsAffected ?? 0);
  }
  return written;
}

export interface ObservedTrader {
  readonly trader: string;
  /** Sells that realized something: exits, not necessarily full ones. */
  readonly closedTrips: number;
  readonly wins: number;
  /** Lamports made on the part of its positions the wallet has sold. */
  readonly realizedPnl: string;
  /** What the sold part cost, which is what the wallet actually had at risk. */
  readonly solTraded: string;
  readonly tokens: number;
  readonly lastTradedAt: number | null;
}

/**
 * What each wallet actually made, on the part of its positions it has sold.
 *
 * Nothing unsold is ever marked. Pricing what a wallet still holds would mean
 * pricing every token every wallet holds, a chain read each, to produce a
 * number nobody asked for and that moves on its own. Only money that has come
 * back out is counted.
 *
 * WHY THIS IS AVERAGE COST AND NOT ROUND TRIPS
 *
 * It scored round trips first: buy a token, sell out of it, one finished trip.
 * That is the cleanest definition and on real wallets it scores almost nobody.
 * A wallet read straight off the chain here bought eight tokens sixteen times
 * each and sold each of them eight times, and finished holding every one. Zero
 * closed trips out of a hundred and ninety-nine real trades. Scaling out of a
 * position and keeping a tail is not an edge case, it is how most people trade,
 * and a board that cannot see it is a board of nobody.
 *
 * So every sell realizes: the tokens leaving are charged the average of what
 * that wallet paid for the tokens it held, and the difference is money made or
 * lost, booked then. The remainder keeps its share of the cost and waits for
 * the next sell. It is the same arithmetic an accountant would use and it has
 * the property that matters here: it never needs to know what anything is worth
 * now, only what it cost and what it fetched.
 *
 * Two things it deliberately refuses to guess at. A sell with nothing held is a
 * position opened before this table starts, so it is skipped rather than booked
 * as proceeds against no cost, which would be pure invented profit. A sell
 * larger than the holding is credited only for the part that can be accounted
 * for.
 */

interface Position {
  held: bigint;
  cost: bigint;
}

interface Tally {
  exits: number;
  wins: number;
  pnl: bigint;
  staked: bigint;
  mints: Set<string>;
  lastAt: number;
}

/** The board, plus how many wallets are scoreable at all. */
export interface ObservedBoard {
  readonly traders: ObservedTrader[];
  /** Wallets that have realized something, before the floor is applied. */
  readonly scoreable: number;
}

/**
 * How many swaps a single ranking will walk.
 *
 * A ceiling rather than a tuning knob: the walk itself is fast, but the rows
 * have to be held in memory to be ordered per wallet, and an unbounded read of
 * a table that grows with every wallet harvested is how a background job takes
 * the site down. Well above anything the retention window allows today.
 */
const MAX_WALKED_SWAPS = 400_000;

/**
 * How many exits a flawless record has to span before it stops being luck.
 *
 * Six. Two or three winners in a row happens to everybody; being right six
 * times out of six and never once wrong is a script taking a fixed profit, and
 * it described forty-seven of two hundred rows on this board.
 */
const PERFECT_EXITS = 6;

export async function observedBoard(
  db: Client,
  options: {
    readonly since?: number;
    readonly minTrips?: number;
    /** Lamports a wallet must have had at risk on its scored exits. */
    readonly minStaked?: bigint;
    readonly limit?: number;
  } = {},
): Promise<ObservedBoard> {
  const since = options.since ?? 0;
  const minTrips = options.minTrips ?? 2;
  const minStaked = options.minStaked ?? 0n;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

  const result = await db.execute({
    sql: `SELECT trader, mint, is_buy, sol_amount, token_amount, block_time
          FROM observed_swaps
          WHERE COALESCE(block_time, 0) >= ?
          ORDER BY trader, mint, COALESCE(block_time, 0) ASC, slot ASC
          LIMIT ?`,
    args: [since, MAX_WALKED_SWAPS],
  });

  const tallies = new Map<string, Tally>();
  let position: Position | null = null;
  let key = '';

  const realize = (trader: string, mint: string, pnl: bigint, staked: bigint, at: number): void => {
    let tally = tallies.get(trader);
    if (!tally) {
      tally = { exits: 0, wins: 0, pnl: 0n, staked: 0n, mints: new Set(), lastAt: 0 };
      tallies.set(trader, tally);
    }
    tally.exits += 1;
    if (pnl > 0n) tally.wins += 1;
    tally.pnl += pnl;
    tally.staked += staked;
    tally.mints.add(mint);
    if (at > tally.lastAt) tally.lastAt = at;
  };

  for (const row of result.rows) {
    const trader = String(row['trader']);
    const mint = String(row['mint']);
    const rowKey = `${trader}\u0000${mint}`;
    if (rowKey !== key) {
      key = rowKey;
      position = null;
    }

    const sol = BigInt(String(row['sol_amount'] ?? '0'));
    const tokens = BigInt(String(row['token_amount'] ?? '0'));
    const at = Number(row['block_time'] ?? 0);
    if (tokens <= 0n) continue;

    if (Number(row['is_buy']) === 1) {
      position ??= { held: 0n, cost: 0n };
      position.held += tokens;
      position.cost += sol;
      continue;
    }

    // Selling something this table never saw bought. Counting it would be
    // counting proceeds with no cost against them: free money, invented.
    if (position === null || position.held <= 0n) continue;

    const sold = tokens > position.held ? position.held : tokens;
    const proceeds = tokens === sold ? sol : (sol * sold) / tokens;
    // What this slice of the position cost, at the average paid for the whole.
    const spent = sold === position.held ? position.cost : (position.cost * sold) / position.held;

    position.held -= sold;
    position.cost -= spent;
    realize(trader, mint, proceeds - spent, spent, at);
  }

  const ranked = [...tallies.entries()]
    .map(([trader, tally]) => ({
      trader,
      closedTrips: tally.exits,
      wins: tally.wins,
      realizedPnl: tally.pnl.toString(),
      solTraded: tally.staked.toString(),
      tokens: tally.mints.size,
      lastTradedAt: tally.lastAt || null,
    }))
    .sort((a, b) => {
      const gap = BigInt(b.realizedPnl) - BigInt(a.realizedPnl);
      return gap > 0n ? 1 : gap < 0n ? -1 : 0;
    });

  /*
   * The size floor, which is what keeps this a board of traders.
   *
   * pump.fun is full of wallets running the same script on five hundredths of a
   * SOL, and thirty of them turned up identical: five exits, 0.05 traded, sixty
   * per cent, nothing made. Ranked on money, they are all tied at zero and they
   * push everybody real off the page. Nobody is copying a wallet that has never
   * put a tenth of a SOL at risk.
   */
  /*
   * One wallet per fingerprint, and nothing that never loses.
   *
   * A size floor was the wrong instrument. The farms simply came back above it:
   * seven wallets with nine exits, nine wins and 3.6 SOL traded, then five more
   * with nine, nine and 3.7, then four with seventy-two, sixty-five and 0.7.
   * Identical to three significant figures is not a coincidence, it is one
   * operator running one script across a spread of addresses, and no floor
   * expressed in SOL can tell those apart from a person.
   *
   * The shape can. Wallets agreeing on exits, wins and size to within a per
   * cent are collapsed to the largest of them, which keeps the operator on the
   * board exactly once rather than pretending they are not there. And a wallet
   * that has never once been wrong across a real number of exits is not a
   * trader anybody should be shown: on this board that was forty-seven rows in
   * two hundred.
   */
  const seen = new Set<string>();
  const filtered = ranked.filter((row) => {
    if (row.closedTrips < minTrips) return false;
    if (BigInt(row.solTraded) < minStaked) return false;
    // Never wrong, over enough exits for that to mean something.
    if (row.closedTrips >= PERFECT_EXITS && row.wins === row.closedTrips) return false;

    // Two significant figures on the size, so a farm running one script lands
    // in one bucket while two people who happen to have the same exit count do
    // not: they would have to have traded the same amount as well.
    const scale = Number(row.solTraded).toPrecision(2);
    const print = `${row.closedTrips}:${row.wins}:${scale}`;
    if (seen.has(print)) return false;
    seen.add(print);
    return true;
  });

  return { scoreable: ranked.length, traders: filtered.slice(0, limit) };
}

/** The ranking on its own, for callers with no use for the coverage figure. */
export async function observedTraders(
  db: Client,
  options: { readonly since?: number; readonly minTrips?: number; readonly limit?: number } = {},
): Promise<ObservedTrader[]> {
  return (await observedBoard(db, options)).traders;
}

/** How much of this table there is, for the page that admits its own coverage. */
export async function observedCoverage(
  db: Client,
): Promise<{ swaps: number; traders: number; tokens: number }> {
  const result = await db.execute(
    `SELECT COUNT(*) AS swaps,
            COUNT(DISTINCT trader) AS traders,
            COUNT(DISTINCT mint) AS tokens
     FROM observed_swaps`,
  );
  const row = result.rows[0];
  return {
    swaps: Number(row?.['swaps'] ?? 0),
    traders: Number(row?.['traders'] ?? 0),
    tokens: Number(row?.['tokens'] ?? 0),
  };
}

/**
 * Drop swaps older than the window.
 *
 * This table grows with every pool walked and would otherwise be the next thing
 * to fill the volume, which has happened here once already. Ninety days is more
 * than any board on the site looks back over.
 */
export async function pruneObservedSwaps(db: Client, now: number): Promise<number> {
  const cutoff = Math.floor(now / 1_000) - 90 * 24 * 60 * 60;
  const result = await db.execute({
    sql: 'DELETE FROM observed_swaps WHERE block_time IS NOT NULL AND block_time < ?',
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}

export interface CopyableSwap {
  readonly trader: string;
  readonly mint: string;
  readonly isBuy: boolean;
  /** What the leader put in or took out, in lamports. */
  readonly solAmount: string;
  readonly tokenAmount: string;
  /** The pool their order left behind: what a copier arrives at. */
  readonly solAfter: string;
  readonly tokenAfter: string;
  readonly blockTime: number;
}

/**
 * One wallet's swaps in order, with the pool each one left behind.
 *
 * Oldest first, because a backtest replays forward. Only swaps carrying
 * reserves come back: the price a copier would have paid cannot be worked out
 * without them, and a backtest that guessed would be worth less than no
 * backtest at all.
 */
export async function copyableSwaps(
  db: Client,
  trader: string,
  since: number,
): Promise<CopyableSwap[]> {
  const result = await db.execute({
    sql: `SELECT trader, mint, is_buy, sol_amount, token_amount, sol_after, token_after, block_time
          FROM observed_swaps
          WHERE trader = ?
            AND block_time IS NOT NULL AND block_time >= ?
            AND sol_after IS NOT NULL AND token_after IS NOT NULL
            AND CAST(sol_after AS INTEGER) > 0 AND CAST(token_after AS INTEGER) > 0
          ORDER BY block_time ASC, slot ASC`,
    args: [trader, since],
  });

  return result.rows.map((row) => ({
    trader: String(row['trader']),
    mint: String(row['mint']),
    isBuy: Number(row['is_buy']) === 1,
    solAmount: String(row['sol_amount']),
    tokenAmount: String(row['token_amount']),
    solAfter: String(row['sol_after']),
    tokenAfter: String(row['token_after']),
    blockTime: Number(row['block_time']),
  }));
}

/**
 * One token's swaps in order, with the pool each one left behind.
 *
 * The mirror of `copyableSwaps` above: that one asks what a wallet did, this
 * one asks what happened to a token. A rule backtest walks the pool forward
 * through the reserves real orders really left, so what it needs is every
 * swap against one mint rather than every swap by one trader.
 *
 * Oldest first, because a replay reads forward. Block time is the clock a
 * rule's timeout runs on; slot breaks the tie, since two swaps in one block
 * share a time and only their slot ordering is real.
 *
 * Only swaps carrying reserves come back. A point without them cannot price
 * anything, and a replay that guessed at one would be worth less than no
 * replay at all.
 *
 * The limit takes the oldest, because a replay starts at the beginning. One
 * more row than asked for is fetched so the caller can tell a window that ended
 * because the token stopped trading from one that ended because the read did.
 * Those are different answers and only one of them is a verdict.
 */
export async function tokenTimeline(
  db: Client,
  mint: string,
  limit = 5_000,
): Promise<{ swaps: CopyableSwap[]; truncated: boolean }> {
  const result = await db.execute({
    sql: `SELECT trader, mint, is_buy, sol_amount, token_amount, sol_after, token_after, block_time
          FROM observed_swaps
          WHERE mint = ?
            AND block_time IS NOT NULL
            AND sol_after IS NOT NULL AND token_after IS NOT NULL
            AND CAST(sol_after AS INTEGER) > 0 AND CAST(token_after AS INTEGER) > 0
          ORDER BY block_time ASC, slot ASC
          LIMIT ?`,
    args: [mint, limit + 1],
  });

  const swaps = result.rows.slice(0, limit).map((row) => ({
    trader: String(row['trader']),
    mint: String(row['mint']),
    isBuy: Number(row['is_buy']) === 1,
    solAmount: String(row['sol_amount']),
    tokenAmount: String(row['token_amount']),
    solAfter: String(row['sol_after']),
    tokenAfter: String(row['token_after']),
    blockTime: Number(row['block_time']),
  }));

  return { swaps, truncated: result.rows.length > limit };
}

/**
 * Wallets worth reading in full, most active first.
 *
 * A pool walk turns up hundreds of wallets and can score almost none of them,
 * because it sees half an hour of one token rather than a wallet's own history.
 * This is how the expensive second walk decides where to spend itself: the
 * wallets that turned up most often across the pools already harvested, skipping
 * any walked recently.
 *
 * Ordered by the SOL a wallet has been seen selling, largest first.
 *
 * Two orderings were tried before this and both filled the board with the same
 * kind of wallet. Distinct tokens picks whoever appears in the most pools,
 * which is a market maker that never finishes a position. Sell count picks
 * whoever trades most often, which on pump.fun is a farm: thirty wallets
 * arrived running one script, sixty-two exits and 0.017 SOL made, each
 * indistinguishable from the next down the page.
 *
 * Size is the one ordering a farm cannot fake, because faking it costs the
 * money it is pretending to have. Walking the biggest sellers first spends the
 * expensive read on the wallets somebody would actually want to follow.
 */
export async function walkCandidates(
  db: Client,
  options: { readonly since: number; readonly staleBefore: number; readonly limit?: number },
): Promise<string[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 500);
  const result = await db.execute({
    sql: `SELECT s.trader AS trader
          FROM observed_swaps s
          LEFT JOIN trader_walks w ON w.trader = s.trader
          WHERE COALESCE(s.block_time, 0) >= ?
            AND (w.walked_at IS NULL OR w.walked_at < ?)
          GROUP BY s.trader
          ORDER BY SUM(CASE WHEN s.is_buy = 0 THEN CAST(s.sol_amount AS INTEGER) ELSE 0 END) DESC,
                   COUNT(*) DESC
          LIMIT ?`,
    args: [options.since, options.staleBefore, limit],
  });
  return result.rows.map((row) => String(row['trader']));
}

/** Remember that a wallet's own history has been read, so it is not read again. */
export async function recordTraderWalk(
  db: Client,
  trader: string,
  swaps: number,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO trader_walks (trader, walked_at, swaps)
          VALUES (?, ?, ?)
          ON CONFLICT (trader) DO UPDATE SET walked_at = excluded.walked_at, swaps = excluded.swaps`,
    args: [trader, now, swaps],
  });
}

/** How many wallets have had their own history read. */
export async function walkedTraderCount(db: Client): Promise<number> {
  const result = await db.execute('SELECT COUNT(*) AS walked FROM trader_walks');
  return Number(result.rows[0]?.['walked'] ?? 0);
}
