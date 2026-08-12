import type { Client } from '@libsql/client';
import type { Launch } from './launches';

/**
 * Bonding curve progress, cached.
 *
 * pump.fun tokens live in three states and traders treat them as three
 * different things: freshly launched, close to graduating, and graduated. The
 * distinction is not age — a token can sit at 2% for a week or graduate in
 * ninety seconds — so it has to come from the curve account itself.
 */

/**
 * Tokens available to the curve at launch.
 *
 * Not a guess. Every fresh curve read off mainnet reports exactly this in
 * `real_token_reserves`, and it is the denominator progress is measured
 * against: a curve graduates when these are exhausted.
 */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

export interface CurveState {
  readonly mint: string;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  /**
   * What a price comes from.
   *
   * Null on a row written before these were stored, and on a graduated curve
   * whose reserves have been zeroed. Null means "no price available", which is
   * different from a price of zero.
   */
  readonly virtualSolReserves: bigint | null;
  readonly virtualTokenReserves: bigint | null;
  /** 0 to 10000. How close the curve is to graduating. */
  readonly progressBps: number;
  readonly complete: boolean;
  readonly updatedAt: number;
}

/** A launch with whatever is known about how far along it is. */
export interface LaunchWithCurve extends Launch {
  readonly curve: CurveState | null;
}

function optionalBigint(value: unknown): bigint | null {
  return value === null || value === undefined ? null : BigInt(String(value));
}

function toCurve(row: Record<string, unknown>): CurveState {
  return {
    mint: String(row['mint']),
    realSolReserves: BigInt(String(row['real_sol_reserves'])),
    realTokenReserves: BigInt(String(row['real_token_reserves'])),
    virtualSolReserves: optionalBigint(row['virtual_sol_reserves']),
    virtualTokenReserves: optionalBigint(row['virtual_token_reserves']),
    progressBps: Number(row['progress_bps']),
    complete: Number(row['complete']) === 1,
    updatedAt: Number(row['updated_at']),
  };
}

/**
 * How far along a curve is, in basis points.
 *
 * A graduated curve reads 100% regardless of its reserves, because on
 * graduation every reserve field is zeroed — computing from those would report
 * a token that just succeeded as being at zero progress, which is the exact
 * inverse of the truth.
 */
export function progressBpsFor(realTokenReserves: bigint, complete: boolean): number {
  if (complete) return 10_000;
  if (realTokenReserves >= INITIAL_REAL_TOKEN_RESERVES) return 0;

  const sold = INITIAL_REAL_TOKEN_RESERVES - realTokenReserves;
  const bps = Number((sold * 10_000n) / INITIAL_REAL_TOKEN_RESERVES);
  // Clamped rather than trusted. A curve seeded differently by a future
  // program version must not be able to write a value the column rejects.
  return Math.max(0, Math.min(10_000, bps));
}

export interface CurveWrite {
  readonly mint: string;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly complete: boolean;
}

/** Record what the chain says, replacing whatever was there. */
export async function recordCurveStates(
  db: Client,
  states: readonly CurveWrite[],
  now: number,
): Promise<number> {
  if (states.length === 0) return 0;

  const result = await db.batch(
    states.map((state) => ({
      sql: `INSERT INTO curve_state
              (mint, real_sol_reserves, real_token_reserves,
               virtual_sol_reserves, virtual_token_reserves,
               progress_bps, complete, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mint) DO UPDATE SET
              real_sol_reserves      = excluded.real_sol_reserves,
              real_token_reserves    = excluded.real_token_reserves,
              -- A graduated curve reports zero for everything, which is not a
              -- price of zero. Keeping the last real reading means a token
              -- that just bonded still shows what it was worth.
              virtual_sol_reserves   = CASE WHEN excluded.virtual_token_reserves = '0'
                                            THEN curve_state.virtual_sol_reserves
                                            ELSE excluded.virtual_sol_reserves END,
              virtual_token_reserves = CASE WHEN excluded.virtual_token_reserves = '0'
                                            THEN curve_state.virtual_token_reserves
                                            ELSE excluded.virtual_token_reserves END,
              progress_bps           = excluded.progress_bps,
              complete               = excluded.complete,
              updated_at             = excluded.updated_at`,
      args: [
        state.mint,
        state.realSolReserves.toString(),
        state.realTokenReserves.toString(),
        state.virtualSolReserves.toString(),
        state.virtualTokenReserves.toString(),
        progressBpsFor(state.realTokenReserves, state.complete),
        state.complete ? 1 : 0,
        now,
      ],
    })),
    'write',
  );

  return result.reduce((sum, one) => sum + Number(one.rowsAffected), 0);
}

export async function curveStatesFor(
  db: Client,
  mints: readonly string[],
): Promise<Map<string, CurveState>> {
  if (mints.length === 0) return new Map();

  const placeholders = mints.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT * FROM curve_state WHERE mint IN (${placeholders})`,
    args: [...mints],
  });

  const found = new Map<string, CurveState>();
  for (const row of result.rows) {
    const state = toCurve(row as unknown as Record<string, unknown>);
    found.set(state.mint, state);
  }
  return found;
}

function joined(rows: readonly Record<string, unknown>[]): LaunchWithCurve[] {
  return rows.map((row) => ({
    mint: String(row['mint']),
    bondingCurve: String(row['bonding_curve']),
    creator: String(row['creator']),
    name: String(row['name']),
    symbol: String(row['symbol']),
    uri: String(row['uri']),
    launchedAt: Number(row['launched_at']),
    slot: row['slot'] === null || row['slot'] === undefined ? null : Number(row['slot']),
    firstSeenAt: Number(row['first_seen_at']),
    curve:
      row['progress_bps'] === null || row['progress_bps'] === undefined
        ? null
        : toCurve(row as unknown as Record<string, unknown>),
  }));
}

/**
 * The three lanes.
 *
 * A left join, not an inner one: a token launched seconds ago has no curve row
 * yet because nothing has read its account, and dropping it would make the
 * newest lane — the one people watch — the emptiest.
 */
export async function newLaunches(db: Client, limit: number): Promise<LaunchWithCurve[]> {
  const result = await db.execute({
    sql: `SELECT l.*, c.real_sol_reserves, c.real_token_reserves,
                 c.virtual_sol_reserves, c.virtual_token_reserves, c.progress_bps,
                 c.complete, c.updated_at
          FROM launches l
          LEFT JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete IS NULL OR c.complete = 0
          ORDER BY l.launched_at DESC
          LIMIT ?`,
    args: [limit],
  });
  return joined(result.rows as unknown as Record<string, unknown>[]);
}

/**
 * Closest to graduating first.
 *
 * A floor rather than the whole list: without one this lane is just the new
 * lane in a different order, and a token at 0.4% is not "about to bond".
 */
export async function bondingLaunches(
  db: Client,
  minProgressBps: number,
  limit: number,
): Promise<LaunchWithCurve[]> {
  const result = await db.execute({
    sql: `SELECT l.*, c.real_sol_reserves, c.real_token_reserves,
                 c.virtual_sol_reserves, c.virtual_token_reserves, c.progress_bps,
                 c.complete, c.updated_at
          FROM launches l
          JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete = 0 AND c.progress_bps >= ?
          -- progress_bps is a 0..10000 integer with heavy ties, so without a
          -- stable tiebreak the LIMIT cut and the row order both wander between
          -- identical requests and a token flickers in and out of the lane.
          ORDER BY c.progress_bps DESC, l.launched_at DESC, l.mint
          LIMIT ?`,
    args: [minProgressBps, limit],
  });
  return joined(result.rows as unknown as Record<string, unknown>[]);
}

/** Graduated, most recently confirmed first. */
export async function bondedLaunches(db: Client, limit: number): Promise<LaunchWithCurve[]> {
  const result = await db.execute({
    sql: `SELECT l.*, c.real_sol_reserves, c.real_token_reserves,
                 c.virtual_sol_reserves, c.virtual_token_reserves, c.progress_bps,
                 c.complete, c.updated_at
          FROM launches l
          JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete = 1
          -- A whole batch is written with one shared updated_at, so many rows
          -- tie; the mint breaks them so the LIMIT cut is stable rather than
          -- letting a graduated token jump position for no state change.
          ORDER BY c.updated_at DESC, l.mint
          LIMIT ?`,
    args: [limit],
  });
  return joined(result.rows as unknown as Record<string, unknown>[]);
}

/**
 * What to read next.
 *
 * Ordered by how long ago each was last read, so a fixed budget of RPC calls
 * spreads evenly instead of refreshing the same handful forever. Curves that
 * have graduated are excluded: they are terminal and will never change again,
 * so re-reading them is spending a call to learn nothing.
 */
export async function curvesToRefresh(
  db: Client,
  limit: number,
  launchedAfter: number,
): Promise<{ mint: string; bondingCurve: string }[]> {
  const result = await db.execute({
    sql: `SELECT l.mint, l.bonding_curve
          FROM launches l
          LEFT JOIN curve_state c ON c.mint = l.mint
          WHERE l.launched_at >= ? AND (c.complete IS NULL OR c.complete = 0)
          ORDER BY COALESCE(c.updated_at, 0) ASC, l.launched_at DESC
          LIMIT ?`,
    args: [launchedAfter, limit],
  });

  return result.rows.map((row) => ({
    mint: String(row['mint']),
    bondingCurve: String(row['bonding_curve']),
  }));
}

/**
 * Graduated tokens whose price is stalest.
 *
 * Separate from {@link curvesToRefresh} because they are read a different way
 * and cost far more. A graduated curve zeroes its reserves, so there is no
 * price left on it — the market moved to an AMM pool whose address is not
 * derivable and has to be searched for. That is several calls per token rather
 * than a hundred tokens per call, so this hands back a handful at a time.
 */
export async function gradsToRefresh(
  db: Client,
  limit: number,
  stalerThan: number,
): Promise<{ mint: string; bondingCurve: string }[]> {
  const result = await db.execute({
    sql: `SELECT l.mint, l.bonding_curve
          FROM launches l
          JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete = 1 AND c.updated_at < ?
          ORDER BY c.updated_at ASC
          LIMIT ?`,
    args: [stalerThan, limit],
  });

  return result.rows.map((row) => ({
    mint: String(row['mint']),
    bondingCurve: String(row['bonding_curve']),
  }));
}

/**
 * Graduated tokens that have never been priced.
 *
 * When a token bonds its curve zeroes its reserves, so until the pool behind it
 * is read it has no market cap and the feed shows it as n/a. The staleness
 * rotation above will not touch it for minutes, because it was just written and
 * so is not stale. These are the ones a fresh visitor sees as blank, so they
 * jump the queue: no price yet, newest first, priced before anything is merely
 * refreshed.
 */
export async function unpricedGrads(
  db: Client,
  limit: number,
): Promise<{ mint: string; bondingCurve: string }[]> {
  const result = await db.execute({
    sql: `SELECT l.mint, l.bonding_curve
          FROM launches l
          JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete = 1
            AND (c.virtual_sol_reserves IS NULL OR c.virtual_sol_reserves = '0'
                 OR c.virtual_token_reserves IS NULL OR c.virtual_token_reserves = '0')
          ORDER BY c.updated_at DESC
          LIMIT ?`,
    args: [limit],
  });

  return result.rows.map((row) => ({
    mint: String(row['mint']),
    bondingCurve: String(row['bonding_curve']),
  }));
}
