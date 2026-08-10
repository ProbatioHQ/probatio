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
  /** 0 to 10000. How close the curve is to graduating. */
  readonly progressBps: number;
  readonly complete: boolean;
  readonly updatedAt: number;
}

/** A launch with whatever is known about how far along it is. */
export interface LaunchWithCurve extends Launch {
  readonly curve: CurveState | null;
}

function toCurve(row: Record<string, unknown>): CurveState {
  return {
    mint: String(row['mint']),
    realSolReserves: BigInt(String(row['real_sol_reserves'])),
    realTokenReserves: BigInt(String(row['real_token_reserves'])),
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
              (mint, real_sol_reserves, real_token_reserves, progress_bps, complete, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (mint) DO UPDATE SET
              real_sol_reserves   = excluded.real_sol_reserves,
              real_token_reserves = excluded.real_token_reserves,
              progress_bps        = excluded.progress_bps,
              complete            = excluded.complete,
              updated_at          = excluded.updated_at`,
      args: [
        state.mint,
        state.realSolReserves.toString(),
        state.realTokenReserves.toString(),
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
    sql: `SELECT l.*, c.real_sol_reserves, c.real_token_reserves, c.progress_bps,
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
    sql: `SELECT l.*, c.real_sol_reserves, c.real_token_reserves, c.progress_bps,
                 c.complete, c.updated_at
          FROM launches l
          JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete = 0 AND c.progress_bps >= ?
          ORDER BY c.progress_bps DESC
          LIMIT ?`,
    args: [minProgressBps, limit],
  });
  return joined(result.rows as unknown as Record<string, unknown>[]);
}

/** Graduated, most recently confirmed first. */
export async function bondedLaunches(db: Client, limit: number): Promise<LaunchWithCurve[]> {
  const result = await db.execute({
    sql: `SELECT l.*, c.real_sol_reserves, c.real_token_reserves, c.progress_bps,
                 c.complete, c.updated_at
          FROM launches l
          JOIN curve_state c ON c.mint = l.mint
          WHERE c.complete = 1
          ORDER BY c.updated_at DESC
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
