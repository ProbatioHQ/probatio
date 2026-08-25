import { createHash } from 'node:crypto';
import type { Client } from './client';

/**
 * Head to head duels.
 *
 * A duel is a window two traders agreed to, scored off the accounts they already
 * entered the season with. There is no duel balance: the trades inside the
 * window are ordinary season trades that also count toward the leaderboard, and
 * they would have been filled identically with no duel open.
 *
 * What this file owns is the agreement and the arithmetic. Working out what an
 * account is worth belongs to the layer that can read prices, so equity arrives
 * here already measured and this file never guesses at one.
 */

export class DuelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuelError';
  }
}

export type DuelStatus = 'offered' | 'live' | 'settled' | 'declined' | 'withdrawn' | 'expired';

export interface DuelRow {
  readonly id: number;
  readonly seasonId: number;
  readonly challenger: string;
  readonly opponent: string;
  readonly status: DuelStatus;
  readonly windowSeconds: number;
  readonly createdAt: number;
  readonly offerExpiresAt: number;
  readonly startedAt: number | null;
  readonly endsAt: number | null;
  readonly settledAt: number | null;
  readonly challengerOpen: string | null;
  readonly opponentOpen: string | null;
  readonly challengerClose: string | null;
  readonly opponentClose: string | null;
  readonly challengerBps: number | null;
  readonly opponentBps: number | null;
  readonly unpricedOpen: number;
  readonly unpricedClose: number;
  readonly winner: string | null;
  readonly seal: string | null;
}

/**
 * The windows a duel may run for.
 *
 * A fixed set rather than any number of seconds, because the window is half of
 * what somebody is agreeing to and "one hour" is a thing two people can mean the
 * same way. It also keeps a challenger from offering a window of eleven seconds
 * and winning on one lucky fill.
 */
export const DUEL_WINDOWS: readonly number[] = [3_600, 21_600, 86_400];

/** How long an unanswered offer stands before it lapses. */
export const OFFER_TTL_MS = 30 * 60_000;

/** The most offers one person may have outstanding at once. */
export const MAX_OPEN_OFFERS = 5;

function toDuel(row: Record<string, unknown>): DuelRow {
  const num = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  const str = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);
  return {
    id: Number(row['id']),
    seasonId: Number(row['season_id']),
    challenger: String(row['challenger']),
    opponent: String(row['opponent']),
    status: String(row['status']) as DuelStatus,
    windowSeconds: Number(row['window_seconds']),
    createdAt: Number(row['created_at']),
    offerExpiresAt: Number(row['offer_expires_at']),
    startedAt: num('started_at'),
    endsAt: num('ends_at'),
    settledAt: num('settled_at'),
    challengerOpen: str('challenger_open'),
    opponentOpen: str('opponent_open'),
    challengerClose: str('challenger_close'),
    opponentClose: str('opponent_close'),
    challengerBps: num('challenger_bps'),
    opponentBps: num('opponent_bps'),
    unpricedOpen: Number(row['unpriced_open'] ?? 0),
    unpricedClose: Number(row['unpriced_close'] ?? 0),
    winner: str('winner'),
    seal: str('seal'),
  };
}

/**
 * Offer a duel.
 *
 * Refuses rather than reports, because every one of these is a thing the person
 * offering needs told rather than a state the screen should render. The checks
 * that can be enforced by the schema are, and these are the ones that cannot.
 */
export async function offerDuel(
  db: Client,
  input: {
    readonly seasonId: number;
    readonly challenger: string;
    readonly opponent: string;
    readonly windowSeconds: number;
  },
  now: number,
): Promise<DuelRow> {
  if (input.challenger === input.opponent) {
    throw new DuelError('you cannot duel yourself');
  }
  if (!DUEL_WINDOWS.includes(input.windowSeconds)) {
    throw new DuelError('that is not one of the windows a duel can run for');
  }

  /*
   * A live duel on either side stops another being offered.
   *
   * The unique indexes already stop a second one being *accepted*, but an offer
   * that can never be accepted is worse than a refusal: it sits in somebody's
   * list looking actionable, and pressing accept fails with a database error
   * rather than a sentence.
   */
  const live = await db.execute({
    sql: `SELECT 1 FROM duels
          WHERE status = 'live' AND (challenger = ? OR opponent = ? OR challenger = ? OR opponent = ?)
          LIMIT 1`,
    args: [input.challenger, input.challenger, input.opponent, input.opponent],
  });
  if (live.rows[0]) {
    throw new DuelError('one of you is already in a duel');
  }

  const existing = await db.execute({
    sql: `SELECT 1 FROM duels
          WHERE status = 'offered' AND offer_expires_at > ?
            AND ((challenger = ? AND opponent = ?) OR (challenger = ? AND opponent = ?))
          LIMIT 1`,
    args: [now, input.challenger, input.opponent, input.opponent, input.challenger],
  });
  if (existing.rows[0]) {
    throw new DuelError('there is already an open offer between you two');
  }

  const open = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM duels
          WHERE challenger = ? AND status = 'offered' AND offer_expires_at > ?`,
    args: [input.challenger, now],
  });
  if (Number(open.rows[0]?.['n'] ?? 0) >= MAX_OPEN_OFFERS) {
    throw new DuelError(`you already have ${MAX_OPEN_OFFERS} offers out`);
  }

  const result = await db.execute({
    sql: `INSERT INTO duels
            (season_id, challenger, opponent, status, window_seconds, created_at, offer_expires_at)
          VALUES (?, ?, ?, 'offered', ?, ?, ?)
          RETURNING *`,
    args: [
      input.seasonId,
      input.challenger,
      input.opponent,
      input.windowSeconds,
      now,
      now + OFFER_TTL_MS,
    ],
  });
  const row = result.rows[0];
  if (!row) throw new DuelError('the duel could not be offered');
  return toDuel(row as unknown as Record<string, unknown>);
}

export async function duelById(db: Client, id: number): Promise<DuelRow | null> {
  const result = await db.execute({ sql: 'SELECT * FROM duels WHERE id = ?', args: [id] });
  const row = result.rows[0];
  return row ? toDuel(row as unknown as Record<string, unknown>) : null;
}

/**
 * Accept an offer, with both opening equities.
 *
 * The snapshots are passed in rather than read here, and the update is
 * conditional on the duel still being an unexpired offer. Two accepts arriving
 * together would otherwise both succeed, and the second would overwrite the
 * first's opening snapshot with one taken seconds later: a duel that began at a
 * different moment for each trader.
 */
export async function acceptDuel(
  db: Client,
  input: {
    readonly id: number;
    readonly opponent: string;
    readonly challengerOpen: bigint;
    readonly opponentOpen: bigint;
    readonly unpriced: number;
  },
  now: number,
): Promise<DuelRow> {
  const duel = await duelById(db, input.id);
  if (!duel) throw new DuelError('there is no such duel');
  if (duel.opponent !== input.opponent) throw new DuelError('that duel was not offered to you');
  if (duel.status !== 'offered') throw new DuelError(`that duel is ${duel.status}`);
  if (duel.offerExpiresAt <= now) throw new DuelError('that offer has expired');

  /*
   * Either of them may have gone live since this was offered.
   *
   * The pair rule stops two offers between the same two people; it does not
   * stop two different people offering the same person a duel, which is
   * ordinary and should be allowed. So by the time somebody accepts, either
   * side may already be duelling: they accepted somebody else's challenge a
   * moment ago, or the challenger did.
   *
   * The partial unique indexes catch it either way, but they catch it as a
   * constraint violation, which reaches the route as a five hundred rather than
   * as a sentence. Checked here so the ordinary case reads properly, and caught
   * below so the racing case does too.
   */
  const busy = await db.execute({
    sql: `SELECT challenger, opponent FROM duels
          WHERE status = 'live' AND (challenger IN (?, ?) OR opponent IN (?, ?))
          LIMIT 1`,
    args: [duel.challenger, duel.opponent, duel.challenger, duel.opponent],
  });
  if (busy.rows[0]) {
    const other = String(busy.rows[0]['challenger']);
    const involved = other === duel.opponent || String(busy.rows[0]['opponent']) === duel.opponent;
    throw new DuelError(
      involved ? 'you are already in a duel' : 'they are already in a duel',
    );
  }

  let result;
  try {
    result = await db.execute({
      sql: `UPDATE duels
            SET status = 'live', started_at = ?, ends_at = ?,
                challenger_open = ?, opponent_open = ?, unpriced_open = ?
            WHERE id = ? AND status = 'offered' AND offer_expires_at > ?
            RETURNING *`,
      args: [
        now,
        now + duel.windowSeconds * 1_000,
        input.challengerOpen.toString(),
        input.opponentOpen.toString(),
        input.unpriced,
        input.id,
        now,
      ],
    });
  } catch (error) {
    /*
     * Two accepts landing together both pass the check above and one loses the
     * index. That is the constraint doing its job, so it becomes the same
     * sentence rather than an error page: from where the person is sitting,
     * losing by a millisecond and being second by a minute are the same thing.
     */
    if (String((error as { code?: unknown }).code ?? '').includes('CONSTRAINT_UNIQUE')) {
      throw new DuelError('one of you is already in a duel');
    }
    throw error;
  }

  const row = result.rows[0];
  if (!row) throw new DuelError('that duel is no longer open to accept');
  return toDuel(row as unknown as Record<string, unknown>);
}

/** Decline, or withdraw one you offered. Both only apply to an open offer. */
export async function closeOffer(
  db: Client,
  input: { readonly id: number; readonly by: string; readonly status: 'declined' | 'withdrawn' },
): Promise<DuelRow> {
  const duel = await duelById(db, input.id);
  if (!duel) throw new DuelError('there is no such duel');
  if (duel.status !== 'offered') throw new DuelError(`that duel is ${duel.status}`);

  const who = input.status === 'declined' ? duel.opponent : duel.challenger;
  if (who !== input.by) {
    throw new DuelError(
      input.status === 'declined' ? 'that duel was not offered to you' : 'you did not offer that',
    );
  }

  const result = await db.execute({
    sql: `UPDATE duels SET status = ? WHERE id = ? AND status = 'offered' RETURNING *`,
    args: [input.status, input.id],
  });
  const row = result.rows[0];
  if (!row) throw new DuelError('that offer is no longer open');
  return toDuel(row as unknown as Record<string, unknown>);
}

/**
 * The return between two equities, in basis points.
 *
 * An account that opened at nothing has no return to report, and dividing by it
 * would be an error rather than a very large number. Nought is the honest answer
 * there: it neither won nor lost anything it had.
 */
export function returnBps(open: bigint, close: bigint): number {
  if (open <= 0n) return 0;
  return Number(((close - open) * 10_000n) / open);
}

/**
 * What a settled duel commits to.
 *
 * Everything the result depends on, so a screenshot of an outcome can be checked
 * against the record rather than believed. Deliberately including the unpriced
 * counts: a result measured throughout and a result partly assumed are different
 * claims and must not hash the same.
 */
export function duelSeal(input: {
  readonly id: number;
  readonly seasonId: number;
  readonly challenger: string;
  readonly opponent: string;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly challengerOpen: string;
  readonly opponentOpen: string;
  readonly challengerClose: string;
  readonly opponentClose: string;
  readonly unpricedOpen: number;
  readonly unpricedClose: number;
}): string {
  const body = [
    'duel/1',
    input.id,
    input.seasonId,
    input.challenger,
    input.opponent,
    input.startedAt,
    input.endsAt,
    input.challengerOpen,
    input.opponentOpen,
    input.challengerClose,
    input.opponentClose,
    input.unpricedOpen,
    input.unpricedClose,
  ].join('\n');
  return createHash('sha256').update(body).digest('hex');
}

/** Live duels whose window has closed, oldest first. */
export async function dueDuels(db: Client, now: number, limit = 20): Promise<DuelRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM duels WHERE status = 'live' AND ends_at <= ?
          ORDER BY ends_at ASC LIMIT ?`,
    args: [now, limit],
  });
  return result.rows.map((row) => toDuel(row as unknown as Record<string, unknown>));
}

/**
 * Write a result.
 *
 * Conditional on the duel still being live, so a settler that ran twice cannot
 * overwrite a settled result with a second pair of snapshots taken later. The
 * winner is worked out here rather than passed in, because a result and the
 * numbers it came from disagreeing is the one thing a settled duel must not do.
 */
export async function settleDuel(
  db: Client,
  input: {
    readonly id: number;
    readonly challengerClose: bigint;
    readonly opponentClose: bigint;
    readonly unpriced: number;
  },
  now: number,
): Promise<DuelRow | null> {
  const duel = await duelById(db, input.id);
  if (!duel || duel.status !== 'live') return null;
  if (duel.challengerOpen === null || duel.opponentOpen === null) return null;
  if (duel.startedAt === null || duel.endsAt === null) return null;

  const cBps = returnBps(BigInt(duel.challengerOpen), input.challengerClose);
  const oBps = returnBps(BigInt(duel.opponentOpen), input.opponentClose);
  const winner = cBps === oBps ? null : cBps > oBps ? duel.challenger : duel.opponent;

  const seal = duelSeal({
    id: duel.id,
    seasonId: duel.seasonId,
    challenger: duel.challenger,
    opponent: duel.opponent,
    startedAt: duel.startedAt,
    endsAt: duel.endsAt,
    challengerOpen: duel.challengerOpen,
    opponentOpen: duel.opponentOpen,
    challengerClose: input.challengerClose.toString(),
    opponentClose: input.opponentClose.toString(),
    unpricedOpen: duel.unpricedOpen,
    unpricedClose: input.unpriced,
  });

  const result = await db.execute({
    sql: `UPDATE duels
          SET status = 'settled', settled_at = ?,
              challenger_close = ?, opponent_close = ?,
              challenger_bps = ?, opponent_bps = ?,
              unpriced_close = ?, winner = ?, seal = ?
          WHERE id = ? AND status = 'live'
          RETURNING *`,
    args: [
      now,
      input.challengerClose.toString(),
      input.opponentClose.toString(),
      cBps,
      oBps,
      input.unpriced,
      winner,
      seal,
      input.id,
    ],
  });
  const row = result.rows[0];
  return row ? toDuel(row as unknown as Record<string, unknown>) : null;
}

/** Lapse offers nobody answered. Returns how many were closed. */
export async function expireOffers(db: Client, now: number): Promise<number> {
  const result = await db.execute({
    sql: `UPDATE duels SET status = 'expired'
          WHERE status = 'offered' AND offer_expires_at <= ?`,
    args: [now],
  });
  return Number(result.rowsAffected ?? 0);
}

/** Every duel a trader is in, newest first. */
export async function duelsFor(db: Client, pubkey: string, limit = 40): Promise<DuelRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM duels WHERE challenger = ? OR opponent = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [pubkey, pubkey, limit],
  });
  return result.rows.map((row) => toDuel(row as unknown as Record<string, unknown>));
}

/** The duel a trader is currently in, if any. */
export async function liveDuelFor(db: Client, pubkey: string): Promise<DuelRow | null> {
  const result = await db.execute({
    sql: `SELECT * FROM duels WHERE status = 'live' AND (challenger = ? OR opponent = ?) LIMIT 1`,
    args: [pubkey, pubkey],
  });
  const row = result.rows[0];
  return row ? toDuel(row as unknown as Record<string, unknown>) : null;
}

export interface DuelRecord {
  readonly won: number;
  readonly lost: number;
  readonly drawn: number;
}

/** A trader's head to head record across every settled duel. */
export async function duelRecord(db: Client, pubkey: string): Promise<DuelRecord> {
  const result = await db.execute({
    sql: `SELECT winner FROM duels
          WHERE status = 'settled' AND (challenger = ? OR opponent = ?)`,
    args: [pubkey, pubkey],
  });
  let won = 0;
  let lost = 0;
  let drawn = 0;
  for (const row of result.rows) {
    const winner = row['winner'] === null || row['winner'] === undefined ? null : String(row['winner']);
    if (winner === null) drawn += 1;
    else if (winner === pubkey) won += 1;
    else lost += 1;
  }
  return { won, lost, drawn };
}

/** Recently settled duels, for a public board. */
export async function recentDuels(db: Client, limit = 20): Promise<DuelRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM duels WHERE status = 'settled' ORDER BY settled_at DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((row) => toDuel(row as unknown as Record<string, unknown>));
}
