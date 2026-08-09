import type { Client } from '@libsql/client';

/**
 * Recording downtime.
 *
 * Written by whichever process noticed. The unique index on open outages means
 * two instances seeing the same failure produce one row rather than two, which
 * matters because the total feeds a decision about whether a season counts.
 */

export type Dependency = 'rpc' | 'database' | 'feed' | 'coach';

export interface OutageRow {
  readonly id: number;
  readonly dependency: Dependency;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly detail: string | null;
}

function toRow(row: Record<string, unknown>): OutageRow {
  return {
    id: Number(row['id']),
    dependency: String(row['dependency']) as Dependency,
    startedAt: Number(row['started_at']),
    endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
    detail: row['detail'] === null ? null : String(row['detail']),
  };
}

/**
 * Note that a dependency is down.
 *
 * Idempotent: calling it while an outage is already open changes nothing and
 * does not extend the start time. An outage began when it began, not when the
 * next probe confirmed it.
 */
export async function openOutage(
  db: Client,
  dependency: Dependency,
  now: number,
  detail: string | null,
): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO outages (dependency, started_at, detail) VALUES (?, ?, ?)`,
      args: [dependency, now, detail],
    });
  } catch (error) {
    // The unique index rejected it because one is already open. That is the
    // expected path on every probe after the first.
    if (!/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }
}

/** Note that it recovered. Returns true if an outage was actually closed. */
export async function closeOutage(
  db: Client,
  dependency: Dependency,
  now: number,
): Promise<boolean> {
  const result = await db.execute({
    sql: 'UPDATE outages SET ended_at = ? WHERE dependency = ? AND ended_at IS NULL',
    args: [now, dependency],
  });
  return result.rowsAffected > 0;
}

/** Outages overlapping a window, including ones still open. */
export async function outagesBetween(
  db: Client,
  from: number,
  to: number,
): Promise<OutageRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM outages
          WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
          ORDER BY started_at`,
    args: [to, from],
  });
  return result.rows.map((row) => toRow(row as unknown as Record<string, unknown>));
}

export async function openOutages(db: Client): Promise<OutageRow[]> {
  const result = await db.execute('SELECT * FROM outages WHERE ended_at IS NULL');
  return result.rows.map((row) => toRow(row as unknown as Record<string, unknown>));
}
