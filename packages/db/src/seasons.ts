import type { Client } from '@libsql/client';
import type { SeasonRow } from './trading';

/**
 * Creating and reading ranked seasons.
 *
 * Free play is created on demand and never ends. A ranked season is a distinct
 * thing: it has a start, a deadline, a price, and a ruleset hash recorded
 * before anybody pays. Reading the two through the same functions would make it
 * possible to charge for the free one, so they stay separate.
 */

export interface CreateSeasonInput {
  readonly ordinal: number;
  readonly name: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly entryClosesAt: number;
  readonly startingBalance: string;
  readonly entryCost: string;
  readonly houseBps: number;
  readonly houseThreshold: string;
  readonly latencyMs: number;
  readonly maxPriceImpactBps: number;
  readonly engineVersion: number;
  /** Hex. The 32 bytes the program records for this season. */
  readonly rulesetHash: string;
}

export async function createRankedSeason(
  db: Client,
  input: CreateSeasonInput,
  now: number,
): Promise<number> {
  const result = await db.execute({
    sql: `INSERT INTO seasons
            (ordinal, name, ranked, status, starts_at, ends_at, entry_opens_at, entry_closes_at,
             starting_balance, entry_cost, house_bps, house_threshold,
             latency_ms, max_price_impact_bps, engine_version, scoring_formula_hash, created_at)
          VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [
      input.ordinal,
      input.name,
      input.startsAt,
      input.endsAt,
      input.startsAt,
      input.entryClosesAt,
      input.startingBalance,
      input.entryCost,
      input.houseBps,
      input.houseThreshold,
      input.latencyMs,
      input.maxPriceImpactBps,
      input.engineVersion,
      input.rulesetHash,
      now,
    ],
  });
  return Number(result.rows[0]!['id']);
}

export async function seasonByOrdinal(db: Client, ordinal: number): Promise<SeasonRow | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM seasons WHERE ordinal = ?',
    args: [ordinal],
  });
  const row = result.rows[0];
  return row ? toSeason(row as unknown as Record<string, unknown>) : null;
}

/**
 * The ranked season that is on now, or the next one due.
 *
 * Returns a pending season too. Somebody arriving between seasons should see
 * when the next one opens rather than a blank page implying the competition is
 * over.
 */
export async function currentRankedSeason(db: Client, now: number): Promise<SeasonRow | null> {
  const running = await db.execute({
    sql: `SELECT * FROM seasons
          WHERE ranked = 1 AND starts_at <= ? AND ends_at > ?
          ORDER BY ordinal DESC LIMIT 1`,
    args: [now, now],
  });
  if (running.rows[0]) return toSeason(running.rows[0] as unknown as Record<string, unknown>);

  const upcoming = await db.execute({
    sql: `SELECT * FROM seasons
          WHERE ranked = 1 AND starts_at > ?
          ORDER BY starts_at ASC LIMIT 1`,
    args: [now],
  });
  if (upcoming.rows[0]) return toSeason(upcoming.rows[0] as unknown as Record<string, unknown>);

  const last = await db.execute({
    sql: 'SELECT * FROM seasons WHERE ranked = 1 ORDER BY ordinal DESC LIMIT 1',
    args: [],
  });
  return last.rows[0] ? toSeason(last.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function highestRankedOrdinal(db: Client): Promise<number> {
  const result = await db.execute('SELECT MAX(ordinal) AS top FROM seasons WHERE ranked = 1');
  const top = result.rows[0]?.['top'];
  return top === null || top === undefined ? 0 : Number(top);
}

export interface SeasonTotals {
  readonly entrants: number;
  /** Summed from verified payments, never from a counter. */
  readonly potLamports: bigint;
}

/**
 * What the season has actually taken.
 *
 * Summed from verified payments rather than kept as a running total. A counter
 * is a second source of truth that drifts the first time an increment is missed
 * or applied twice, and this one decides what people are paid.
 */
export async function seasonTotals(db: Client, seasonId: number): Promise<SeasonTotals> {
  const entrants = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM entries WHERE season_id = ?',
    args: [seasonId],
  });

  const payments = await db.execute({
    sql: `SELECT amount FROM payments
          WHERE season_id = ? AND purpose = 'season_entry' AND status = 'verified'`,
    args: [seasonId],
  });

  let pot = 0n;
  for (const row of payments.rows) pot += BigInt(String(row['amount']));

  return { entrants: Number(entrants.rows[0]?.['n'] ?? 0), potLamports: pot };
}

function toSeason(row: Record<string, unknown>): SeasonRow {
  const num = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return {
    id: Number(row['id']),
    ordinal: Number(row['ordinal']),
    name: String(row['name']),
    ranked: Number(row['ranked']) === 1,
    status: String(row['status']),
    startsAt: num('starts_at'),
    endsAt: num('ends_at'),
    entryOpensAt: num('entry_opens_at'),
    entryClosesAt: num('entry_closes_at'),
    startingBalance: String(row['starting_balance']),
    entryCost: String(row['entry_cost']),
  };
}
