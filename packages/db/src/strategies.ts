import { createHash, randomBytes } from 'node:crypto';
import type { Client } from './client';

/**
 * Strategies we run, and keys that let a program run its own.
 *
 * Both are ways of placing an order on an account somebody already entered a
 * season with. Neither is a second account, neither pays a second entry, and
 * neither reaches a different engine. What they change is who decides when to
 * trade, which is exactly the thing worth recording and exactly the thing this
 * file keeps track of.
 */

export class StrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategyError';
  }
}

export type StrategyStatus = 'draft' | 'running' | 'stopped';

export interface StrategyRow {
  readonly id: number;
  readonly userPubkey: string;
  readonly seasonId: number;
  readonly name: string;
  /** The rules as stored. Parsed by the caller, which owns their shape. */
  readonly rules: string;
  readonly rulesVersion: number;
  readonly status: StrategyStatus;
  readonly stoppedReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
}

export interface StrategyKeyRow {
  readonly id: number;
  readonly userPubkey: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

function toStrategy(row: Record<string, unknown>): StrategyRow {
  return {
    id: Number(row['id']),
    userPubkey: String(row['user_pubkey']),
    seasonId: Number(row['season_id']),
    name: String(row['name']),
    rules: String(row['rules']),
    rulesVersion: Number(row['rules_version']),
    status: String(row['status']) as StrategyStatus,
    stoppedReason: row['stopped_reason'] === null ? null : String(row['stopped_reason']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    startedAt: row['started_at'] === null ? null : Number(row['started_at']),
    stoppedAt: row['stopped_at'] === null ? null : Number(row['stopped_at']),
  };
}

function toKey(row: Record<string, unknown>): StrategyKeyRow {
  return {
    id: Number(row['id']),
    userPubkey: String(row['user_pubkey']),
    name: String(row['name']),
    prefix: String(row['prefix']),
    createdAt: Number(row['created_at']),
    lastUsedAt: row['last_used_at'] === null ? null : Number(row['last_used_at']),
    revokedAt: row['revoked_at'] === null ? null : Number(row['revoked_at']),
  };
}

// ---------------------------------------------------------------------------
// strategies
// ---------------------------------------------------------------------------

/** Save a strategy as a draft, or replace the draft already there. */
export async function saveStrategy(
  db: Client,
  input: {
    readonly userPubkey: string;
    readonly seasonId: number;
    readonly name: string;
    readonly rules: string;
    readonly rulesVersion: number;
    readonly now: number;
  },
): Promise<StrategyRow> {
  const existing = await db.execute({
    sql: `SELECT * FROM strategies
          WHERE user_pubkey = ? AND season_id = ? AND status != 'running'
          ORDER BY id DESC LIMIT 1`,
    args: [input.userPubkey, input.seasonId],
  });

  const held = existing.rows[0];
  if (held) {
    const updated = await db.execute({
      sql: `UPDATE strategies
            SET name = ?, rules = ?, rules_version = ?, status = 'draft',
                stopped_reason = NULL, updated_at = ?
            WHERE id = ?
            RETURNING *`,
      args: [input.name, input.rules, input.rulesVersion, input.now, Number(held['id'])],
    });
    return toStrategy(updated.rows[0] as unknown as Record<string, unknown>);
  }

  const created = await db.execute({
    sql: `INSERT INTO strategies
            (user_pubkey, season_id, name, rules, rules_version, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
          RETURNING *`,
    args: [
      input.userPubkey,
      input.seasonId,
      input.name,
      input.rules,
      input.rulesVersion,
      input.now,
      input.now,
    ],
  });
  return toStrategy(created.rows[0] as unknown as Record<string, unknown>);
}

/** This account's strategy for a season, running or not. */
export async function strategyFor(
  db: Client,
  userPubkey: string,
  seasonId: number,
): Promise<StrategyRow | null> {
  const result = await db.execute({
    sql: `SELECT * FROM strategies
          WHERE user_pubkey = ? AND season_id = ?
          ORDER BY (status = 'running') DESC, id DESC
          LIMIT 1`,
    args: [userPubkey, seasonId],
  });
  const row = result.rows[0];
  return row ? toStrategy(row as unknown as Record<string, unknown>) : null;
}

/**
 * Start a strategy.
 *
 * The unique index does the real work: one running strategy per account per
 * season, enforced by the schema rather than by whoever remembers to check.
 * Two strategies on one balance would each size their entries against SOL the
 * other is spending.
 */
export async function startStrategy(
  db: Client,
  id: number,
  now: number,
): Promise<StrategyRow> {
  try {
    const result = await db.execute({
      sql: `UPDATE strategies
            SET status = 'running', started_at = ?, stopped_at = NULL,
                stopped_reason = NULL, updated_at = ?
            WHERE id = ? AND status != 'running'
            RETURNING *`,
      args: [now, now, id],
    });
    const row = result.rows[0];
    if (!row) throw new StrategyError('that strategy is already running');
    return toStrategy(row as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof StrategyError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      throw new StrategyError('you already have a strategy running in this season');
    }
    throw error;
  }
}

/** Stop a strategy, and say why. Idempotent: stopping a stopped one is fine. */
export async function stopStrategy(
  db: Client,
  id: number,
  reason: string,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE strategies
          SET status = 'stopped', stopped_at = ?, stopped_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'running'`,
    args: [now, reason, now, id],
  });
}

/**
 * Strategies still marked running against some other season.
 *
 * A season ending is not an event anything here observes. When one closes and
 * the next opens, the runner asks for the strategies of the season that is
 * running now and simply never looks at the last one's again, so they sit marked
 * `running` for ever: a row asserting something that has not been true for a
 * fortnight. Nothing breaks, and that is exactly why it would never have been
 * noticed.
 */
export async function staleRunningStrategies(
  db: Client,
  currentSeasonId: number,
): Promise<StrategyRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM strategies WHERE status = 'running' AND season_id != ? ORDER BY id`,
    args: [currentSeasonId],
  });
  return result.rows.map((row) => toStrategy(row as unknown as Record<string, unknown>));
}

/** Every strategy the runner should be working through. */
export async function runningStrategies(db: Client, seasonId: number): Promise<StrategyRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM strategies WHERE status = 'running' AND season_id = ? ORDER BY id`,
    args: [seasonId],
  });
  return result.rows.map((row) => toStrategy(row as unknown as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// what a strategy has done
// ---------------------------------------------------------------------------

export interface StrategyEvent {
  readonly at: number;
  readonly kind: 'started' | 'stopped' | 'entered' | 'exited' | 'skipped' | 'failed' | 'capped';
  readonly mint: string | null;
  readonly detail: string;
}

export async function recordStrategyEvent(
  db: Client,
  strategyId: number,
  event: StrategyEvent,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO strategy_events (strategy_id, at, kind, mint, detail)
          VALUES (?, ?, ?, ?, ?)`,
    args: [strategyId, event.at, event.kind, event.mint, event.detail],
  });
}

export async function strategyEvents(
  db: Client,
  strategyId: number,
  limit = 50,
): Promise<StrategyEvent[]> {
  const result = await db.execute({
    sql: `SELECT at, kind, mint, detail FROM strategy_events
          WHERE strategy_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    args: [strategyId, limit],
  });
  return result.rows.map((row) => ({
    at: Number(row['at']),
    kind: String(row['kind']) as StrategyEvent['kind'],
    mint: row['mint'] === null ? null : String(row['mint']),
    detail: String(row['detail']),
  }));
}

/**
 * How long a strategy's log is kept.
 *
 * Fourteen days: a season, so the whole of a run stays explicable while it is
 * running and for a little after. It is an explanation rather than a record —
 * the trades are the record, and they are append-only and kept for ever.
 *
 * Swept rather than left, because this table gains a row every time a running
 * strategy declines to do something, which is most ticks of most strategies.
 * The one table on this site that grew on a timer with nothing sweeping it
 * filled the volume and took production down, and this would have been the
 * second.
 */
const EVENT_KEEP_MS = 14 * 24 * 60 * 60 * 1_000;

export async function pruneStrategyEvents(db: Client, now: number): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM strategy_events WHERE at < ?',
    args: [now - EVENT_KEEP_MS],
  });
  return Number(result.rowsAffected ?? 0);
}

/**
 * How many orders this account has placed automatically since a moment.
 *
 * Counted from the trades themselves rather than kept as a running total. A
 * counter is a second copy of a fact, and the copy is what drifts: a process
 * that restarts mid-day, or two runners briefly overlapping during a deploy,
 * would each lose count in a way nobody would notice until a strategy had traded
 * far past its cap. Counting cannot drift, and the index makes it cheap.
 */
export async function automatedTradesSince(
  db: Client,
  accountId: number,
  since: number,
): Promise<number> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM trades
          WHERE account_id = ? AND source IN ('form', 'api') AND created_at >= ?`,
    args: [accountId, since],
  });
  return Number(result.rows[0]?.['n'] ?? 0);
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/** The visible head of a key, so two can be told apart in a list. */
const PREFIX_LENGTH = 12;

/**
 * Hashed with plain SHA-256 rather than a password hash, deliberately.
 *
 * A password is short, guessable and chosen by a person, which is what bcrypt
 * and its relatives exist to compensate for. This is 32 bytes from the system's
 * random source, so there is nothing to guess and a slow hash would buy nothing
 * but latency on every order a program places.
 */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** A new key. The secret is returned once here and never stored anywhere. */
export async function mintStrategyKey(
  db: Client,
  input: { readonly userPubkey: string; readonly name: string; readonly now: number },
): Promise<{ readonly key: string; readonly row: StrategyKeyRow }> {
  const key = `pk_live_${randomBytes(32).toString('base64url')}`;
  const result = await db.execute({
    sql: `INSERT INTO strategy_keys (user_pubkey, name, prefix, key_hash, created_at)
          VALUES (?, ?, ?, ?, ?)
          RETURNING *`,
    args: [
      input.userPubkey,
      input.name,
      key.slice(0, PREFIX_LENGTH),
      hashKey(key),
      input.now,
    ],
  });
  return { key, row: toKey(result.rows[0] as unknown as Record<string, unknown>) };
}

/**
 * Whose key this is, or null.
 *
 * A revoked key resolves to null, which is what makes revocation immediate
 * rather than eventual: there is no cache of live keys to invalidate.
 */
export async function ownerOfKey(
  db: Client,
  key: string,
  now: number,
): Promise<StrategyKeyRow | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM strategy_keys WHERE key_hash = ? AND revoked_at IS NULL',
    args: [hashKey(key)],
  });
  const row = result.rows[0];
  if (!row) return null;

  const held = toKey(row as unknown as Record<string, unknown>);

  /*
   * When it was last used, kept roughly rather than exactly.
   *
   * A program places orders in bursts, and writing this on every one of them
   * would be a write per order to maintain a field nobody reads to the minute.
   * Once a minute is enough to answer the only question it is for, which is
   * whether a key still in the list is a key still in use.
   */
  if (held.lastUsedAt === null || now - held.lastUsedAt > 60_000) {
    await db.execute({
      sql: 'UPDATE strategy_keys SET last_used_at = ? WHERE id = ?',
      args: [now, held.id],
    });
  }

  return held;
}

export async function strategyKeys(db: Client, userPubkey: string): Promise<StrategyKeyRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM strategy_keys WHERE user_pubkey = ? ORDER BY created_at DESC`,
    args: [userPubkey],
  });
  return result.rows.map((row) => toKey(row as unknown as Record<string, unknown>));
}

/** Revoked, never deleted: a key that traded a season stays explicable. */
export async function revokeStrategyKey(
  db: Client,
  userPubkey: string,
  id: number,
  now: number,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE strategy_keys SET revoked_at = ?
          WHERE id = ? AND user_pubkey = ? AND revoked_at IS NULL`,
    args: [now, id, userPubkey],
  });
  return result.rowsAffected > 0;
}
