import type { Client } from '@libsql/client';

/**
 * Recording drift, and acting on it.
 *
 * The write path is deliberately blunt: an exploitable token is suspended in
 * the same transaction that records the observation, so there is no window
 * where the system knows a token is farmable and is still counting trades on
 * it.
 */

export type DriftSeverity = 'ok' | 'watch' | 'divergent' | 'exploitable';

export interface DriftObservation {
  readonly mint: string;
  readonly engineVersion: number;
  readonly samples: number;
  readonly medianSignedBps: number;
  readonly medianAbsBps: number;
  readonly generousSamples: number;
  readonly severity: DriftSeverity;
}

/** A token to bar from ranked trading, with why. */
export interface DriftSuspension {
  readonly mint: string;
  readonly reason: string;
  readonly severity: DriftSeverity;
}

/**
 * The suspension upsert, shared by the atomic record path and the standalone
 * one. It does not refresh the timestamp of an already-active suspension: when a
 * token became farmable is the fact worth keeping, so an active row keeps its
 * original `suspended_at` and only a previously-lifted one is re-stamped.
 */
const SUSPEND_UPSERT = `INSERT INTO suspended_tokens (mint, reason, severity, suspended_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (mint) DO UPDATE SET
    reason = excluded.reason,
    severity = excluded.severity,
    suspended_at = CASE
      WHEN suspended_tokens.lifted_at IS NULL THEN suspended_tokens.suspended_at
      ELSE excluded.suspended_at
    END,
    lifted_at = NULL,
    lifted_note = NULL`;

/**
 * Record observations and, in the SAME transaction, the suspensions they imply.
 *
 * The two used to be separate calls: `recordDrift` committed, then the caller
 * looped `suspendToken`. A crash or interleave between them left an observation
 * on record saying a token was farmable while the token was not actually
 * suspended, so ranked trades kept filling against it. That is the exact window
 * this module claims cannot exist, so the suspensions ride in the same batch as
 * the observations, which libsql runs as one transaction.
 */
export async function recordDrift(
  db: Client,
  observations: readonly DriftObservation[],
  now: number,
  suspensions: readonly DriftSuspension[] = [],
): Promise<void> {
  if (observations.length === 0 && suspensions.length === 0) return;

  await db.batch(
    [
      ...observations.map((observation) => ({
        sql: `INSERT INTO drift_observations
                (mint, engine_version, samples, median_signed_bps, median_abs_bps,
                 generous_samples, severity, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          observation.mint,
          observation.engineVersion,
          observation.samples,
          observation.medianSignedBps,
          observation.medianAbsBps,
          observation.generousSamples,
          observation.severity,
          now,
        ],
      })),
      ...suspensions.map((suspension) => ({
        sql: SUSPEND_UPSERT,
        args: [suspension.mint, suspension.reason, suspension.severity, now],
      })),
    ],
    'write',
  );
}

/**
 * Bar a token from ranked trading on its own, outside a drift batch.
 *
 * Idempotent, and it does not refresh the timestamp of an existing active
 * suspension for the reason in SUSPEND_UPSERT above.
 */
export async function suspendToken(
  db: Client,
  mint: string,
  reason: string,
  severity: DriftSeverity,
  now: number,
): Promise<void> {
  await db.execute({ sql: SUSPEND_UPSERT, args: [mint, reason, severity, now] });
}

/** Lift a suspension. Deliberate and recorded — never automatic. */
export async function liftSuspension(
  db: Client,
  mint: string,
  note: string,
  now: number,
): Promise<void> {
  await db.execute({
    sql: 'UPDATE suspended_tokens SET lifted_at = ?, lifted_note = ? WHERE mint = ? AND lifted_at IS NULL',
    args: [now, note, mint],
  });
}

export async function suspendedTokens(db: Client): Promise<string[]> {
  const result = await db.execute(
    'SELECT mint FROM suspended_tokens WHERE lifted_at IS NULL ORDER BY suspended_at',
  );
  return result.rows.map((row) => String(row['mint']));
}

export async function isSuspended(db: Client, mint: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT 1 FROM suspended_tokens WHERE mint = ? AND lifted_at IS NULL',
    args: [mint],
  });
  return result.rows.length > 0;
}

export interface DriftHistoryEntry extends DriftObservation {
  readonly observedAt: number;
}

/** Recent observations for a token, newest first. */
export async function driftHistory(
  db: Client,
  mint: string,
  limit = 50,
): Promise<DriftHistoryEntry[]> {
  const result = await db.execute({
    sql: `SELECT * FROM drift_observations WHERE mint = ?
          ORDER BY observed_at DESC LIMIT ?`,
    args: [mint, limit],
  });

  return result.rows.map((row) => {
    const record = row as unknown as Record<string, unknown>;
    return {
      mint: String(record['mint']),
      engineVersion: Number(record['engine_version']),
      samples: Number(record['samples']),
      medianSignedBps: Number(record['median_signed_bps']),
      medianAbsBps: Number(record['median_abs_bps']),
      generousSamples: Number(record['generous_samples']),
      severity: String(record['severity']) as DriftSeverity,
      observedAt: Number(record['observed_at']),
    };
  });
}

/**
 * The newest observations across every token, newest first.
 *
 * `driftHistory` answers "how has the engine done on this token", which is the
 * question a token page asks. This answers "how is the engine doing", which is
 * the one a status board asks, and there was no reader for it: finding out
 * meant naming a mint first, so anything watching the engine as a whole had to
 * already know where to look.
 */
export async function recentDrift(db: Client, limit = 50): Promise<DriftHistoryEntry[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM drift_observations ORDER BY observed_at DESC LIMIT ?',
    args: [limit],
  });

  return result.rows.map((row) => {
    const record = row as unknown as Record<string, unknown>;
    return {
      mint: String(record['mint']),
      engineVersion: Number(record['engine_version']),
      samples: Number(record['samples']),
      medianSignedBps: Number(record['median_signed_bps']),
      medianAbsBps: Number(record['median_abs_bps']),
      generousSamples: Number(record['generous_samples']),
      severity: String(record['severity']) as DriftSeverity,
      observedAt: Number(record['observed_at']),
    };
  });
}

/**
 * The mints worth checking the engine against.
 *
 * Ordered by how much they are being traded here, not by how much they trade on
 * the chain. The engine being wrong matters exactly in proportion to how many
 * people it is wrong for, and a farmable token nobody has found is a smaller
 * problem than a mispriced one everybody is holding.
 *
 * Trades already suspended are excluded: they are refused at the trade route,
 * so re-measuring them every cycle spends the RPC budget on the one set of
 * tokens whose answer cannot change anything.
 */
export async function mostTradedMints(
  db: Client,
  since: number,
  limit: number,
): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT t.mint AS mint, COUNT(*) AS n
            FROM trades t
           WHERE t.created_at >= ?
             AND NOT EXISTS (
                   SELECT 1 FROM suspended_tokens s
                    WHERE s.mint = t.mint AND s.lifted_at IS NULL
                 )
        GROUP BY t.mint
        ORDER BY n DESC, t.mint
           LIMIT ?`,
    args: [since, limit],
  });
  return result.rows.map((row) => String(row['mint']));
}
