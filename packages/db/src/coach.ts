import type { Client } from '@libsql/client';

/**
 * Stored coaching reports.
 *
 * Kept rather than recomputed. Every other derived number in this system is
 * rebuilt on demand, because recomputing is free and storing invites two
 * versions that disagree — but a report costs a paid call, and it is a record
 * of what a trader was told at the time. Regenerating it later against a longer
 * history would quietly rewrite advice they may have acted on.
 *
 * The facts the model was given are stored beside what it wrote. That is what
 * makes a report auditable: the wording can be checked against the exact inputs
 * that produced it, rather than against whatever the numbers say today.
 */

export type ReportKind = 'session' | 'weekly' | 'season';

export interface StoredObservation {
  readonly metric: string;
  readonly text: string;
}

export interface StoredCoachReport {
  readonly id: number;
  readonly kind: ReportKind;
  readonly tripsAtReport: number;
  readonly headline: string;
  readonly focus: string;
  readonly observations: readonly StoredObservation[];
  /** The exact facts the model was shown. */
  readonly facts: readonly { key: string; label: string; value: string }[];
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly dropped: number;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly createdAt: number;
}

export interface CoachReportWrite {
  readonly accountId: number;
  readonly seasonId: number | null;
  readonly userPubkey: string;
  readonly kind: ReportKind;
  readonly tripsAtReport: number;
  readonly headline: string;
  readonly focus: string;
  readonly observations: readonly StoredObservation[];
  readonly facts: readonly { key: string; label: string; value: string }[];
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly dropped: number;
  readonly periodStart: number;
  readonly periodEnd: number;
}

function parseArray<T>(raw: unknown): T[] {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // A report whose body cannot be read is still a report that happened, and
    // its timestamp is what the entitlement rule depends on. Discarding the row
    // over unreadable JSON would hand out a free extra call.
    return [];
  }
}

function toReport(row: Record<string, unknown>): StoredCoachReport {
  return {
    id: Number(row['id']),
    kind: String(row['kind']) as ReportKind,
    tripsAtReport: Number(row['trips_at_report']),
    headline: String(row['headline']),
    focus: String(row['focus']),
    observations: parseArray<StoredObservation>(row['body']),
    facts: parseArray<{ key: string; label: string; value: string }>(row['metrics_json']),
    model: String(row['model']),
    inputTokens: Number(row['input_tokens']),
    outputTokens: Number(row['output_tokens']),
    dropped: Number(row['dropped']),
    periodStart: Number(row['period_start']),
    periodEnd: Number(row['period_end']),
    createdAt: Number(row['created_at']),
  };
}

export async function latestCoachReport(
  db: Client,
  accountId: number,
): Promise<StoredCoachReport | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM reports WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    args: [accountId],
  });
  const row = result.rows[0];
  return row ? toReport(row as unknown as Record<string, unknown>) : null;
}

export async function coachReportHistory(
  db: Client,
  accountId: number,
  limit = 20,
): Promise<StoredCoachReport[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM reports WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    args: [accountId, limit],
  });
  return result.rows.map((row) => toReport(row as unknown as Record<string, unknown>));
}

/**
 * Store a report.
 *
 * Returns null when one already exists for this account, kind and trade count.
 * That collision is the entitlement rule enforced by the database rather than
 * by a check that ran moments earlier.
 */
export async function recordCoachReport(
  db: Client,
  write: CoachReportWrite,
  now: number,
): Promise<StoredCoachReport | null> {
  try {
    const result = await db.execute({
      sql: `INSERT INTO reports
              (user_pubkey, account_id, season_id, kind, period_start, period_end,
               metrics_json, body, model, created_at,
               trips_at_report, headline, focus, input_tokens, output_tokens, dropped)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING *`,
      args: [
        write.userPubkey,
        write.accountId,
        write.seasonId,
        write.kind,
        write.periodStart,
        write.periodEnd,
        JSON.stringify(write.facts),
        JSON.stringify(write.observations),
        write.model,
        now,
        write.tripsAtReport,
        write.headline,
        write.focus,
        write.inputTokens,
        write.outputTokens,
        write.dropped,
      ],
    });
    const row = result.rows[0];
    return row ? toReport(row as unknown as Record<string, unknown>) : null;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(message);
}
