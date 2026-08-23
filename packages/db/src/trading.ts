import type { Client } from '@libsql/client';
import { FREE_PLAY_ORDINAL } from './constants';

/**
 * Reading and writing the state a trade changes.
 *
 * A fill touches four things: the account's balance, its position, the trade
 * log and a snapshot of the pool it was quoted against. They are written in one
 * transaction, because a balance that moved without a trade to explain it is
 * unauditable, and a trade without the reserves behind it is unverifiable.
 */

export interface AccountRow {
  readonly id: number;
  readonly seasonId: number;
  readonly seasonOrdinal: number;
  readonly userPubkey: string;
  readonly generation: number;
  readonly solBalance: string;
  readonly startingBalance: string;
  readonly latencyMs: number;
  readonly maxPriceImpactBps: number;
  readonly engineVersion: number;
}

export interface PositionRow {
  readonly id: number;
  readonly mint: string;
  readonly tokenAmount: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly openedAt: number;
}

/**
 * Free play, created on first use.
 *
 * Modelled as a season so nothing downstream has to fork on whether the trader
 * paid to be here.
 */
export async function ensureFreePlaySeason(db: Client, now: number): Promise<number> {
  // ON CONFLICT rather than select-then-insert, for the same reason as
  // ensureAccount below: this runs on a wallet's first visit, and two
  // concurrent first requests both saw no row and both inserted, so the loser
  // hit the ordinal UNIQUE constraint and a first page load 500'd.
  const created = await db.execute({
    sql: `INSERT INTO seasons
            (ordinal, name, ranked, status, starting_balance, entry_cost,
             house_bps, house_threshold, latency_ms, max_price_impact_bps,
             engine_version, scoring_formula_hash, created_at)
          VALUES (?, 'Free play', 0, 'running', '10000000000', '0',
                  0, '0', 600, 5000, 1, 'free', ?)
          ON CONFLICT (ordinal) DO NOTHING
          RETURNING id`,
    args: [FREE_PLAY_ORDINAL, now],
  });
  if (created.rows[0]) return Number(created.rows[0]['id']);

  // Lost the race, or it already existed. Theirs is the same season.
  const existing = await db.execute({
    sql: 'SELECT id FROM seasons WHERE ordinal = ?',
    args: [FREE_PLAY_ORDINAL],
  });
  return Number(existing.rows[0]!['id']);
}

/** The trader's account for a season, created at the starting balance if new. */
export async function ensureAccount(
  db: Client,
  seasonId: number,
  userPubkey: string,
  now: number,
): Promise<AccountRow> {
  const season = await db.execute({
    sql: 'SELECT * FROM seasons WHERE id = ?',
    args: [seasonId],
  });
  const seasonRow = season.rows[0];
  if (!seasonRow) throw new Error(`no season ${seasonId}`);

  const existing = await db.execute({
    sql: `SELECT * FROM accounts WHERE season_id = ? AND user_pubkey = ?
          ORDER BY generation DESC LIMIT 1`,
    args: [seasonId, userPubkey],
  });

  let row = existing.rows[0];
  if (!row) {
    // ON CONFLICT rather than a bare insert. Selecting and then inserting is a
    // race, and this runs on every authenticated request — two concurrent
    // requests from a wallet's first visit both see no account and both try to
    // create one. Found by load testing; the loser used to get an exception on
    // a perfectly ordinary first page load.
    const created = await db.execute({
      sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (season_id, user_pubkey, generation) DO NOTHING
            RETURNING *`,
      args: [seasonId, userPubkey, String(seasonRow['starting_balance']), now, now],
    });

    row = created.rows[0];
    if (!row) {
      // Somebody else created it between the select and the insert. Theirs is
      // the same account this call was about to make.
      const raced = await db.execute({
        sql: `SELECT * FROM accounts WHERE season_id = ? AND user_pubkey = ?
              ORDER BY generation DESC LIMIT 1`,
        args: [seasonId, userPubkey],
      });
      row = raced.rows[0]!;
    }
  }

  return {
    id: Number(row['id']),
    seasonId,
    seasonOrdinal: Number(seasonRow['ordinal']),
    userPubkey,
    generation: Number(row['generation']),
    solBalance: String(row['sol_balance']),
    startingBalance: String(seasonRow['starting_balance']),
    latencyMs: Number(seasonRow['latency_ms']),
    maxPriceImpactBps: Number(seasonRow['max_price_impact_bps']),
    engineVersion: Number(seasonRow['engine_version']),
  };
}

/** The open position in a token, if any. */
export async function openPosition(
  db: Client,
  accountId: number,
  mint: string,
): Promise<PositionRow | null> {
  const result = await db.execute({
    sql: `SELECT * FROM positions WHERE account_id = ? AND mint = ? AND closed_at IS NULL
          ORDER BY opened_at DESC LIMIT 1`,
    args: [accountId, mint],
  });
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: Number(row['id']),
    mint: String(row['mint']),
    tokenAmount: String(row['token_amount']),
    costBasis: String(row['cost_basis']),
    realizedPnl: String(row['realized_pnl']),
    openedAt: Number(row['opened_at']),
  };
}

export interface TradeWrite {
  readonly accountId: number;
  readonly seasonId: number;
  readonly userPubkey: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly fee: string;
  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly poolSource: string;
  readonly clickedAtSlot: number;
  readonly filledAtSlot: number;
  readonly latencyMs: number;
  readonly engineVersion: number;
  readonly leafHash: string;
  /**
   * How the order arrived.
   *
   * Not part of the leaf, and that distinction is load bearing. The leaf is what
   * a stranger recomputes to check a record, and its shape is fixed by the
   * engine version a season committed to; adding a field to it now would
   * invalidate every commit already on chain. So this is recorded beside the
   * leaf rather than inside it: append-only and impossible to rewrite, but not
   * something the chain vouches for. It belongs in the leaf at the next engine
   * version bump, at a season boundary.
   *
   * Optional here only so that the several callers that predate it keep
   * compiling as what they are, which is the website.
   */
  readonly source?: TradeSource;
}

/**
 * The four ways an order can reach the engine.
 *
 * `form` is a strategy we run, `api` is a program the trader runs themselves.
 * Both are automated and they are kept apart because "we did this on your
 * behalf" and "you did this to us" are different claims about who is
 * responsible for a fill.
 */
export type TradeSource = 'web' | 'telegram' | 'form' | 'api';

export interface PoolSnapshotWrite {
  readonly mint: string;
  readonly solReserve: string;
  readonly tokenReserve: string;
  /**
   * The tokens the venue could actually deliver, the engine's buy cap. On a
   * curve this is the real token reserve, which differs from the virtual
   * `tokenReserve` price comes from, and the trade leaf commits to it, so it has
   * to be stored to rebuild the leaf rather than reconstructed from the reserve.
   */
  readonly deliverableTokens: string;
  readonly tokenDecimals: number;
  readonly feeBps: number;
  readonly source: string;
  readonly slot: number;
}

export interface PositionWrite {
  readonly accountId: number;
  readonly mint: string;
  readonly tokenAmount: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly closed: boolean;
}

/**
 * Write everything a fill changed, atomically.
 *
 * If any part fails the whole thing rolls back. A balance that moved without a
 * trade to explain it cannot be audited, and a trade whose pool snapshot never
 * landed cannot be verified — either would be worse than the trade simply
 * failing.
 */
/**
 * A trade whose inputs went stale before it could be written.
 *
 * Raised when the balance or the position moved between the quote and the
 * write. That gap is real and wide: the engine waits out the season's latency
 * in the middle of it, so two clicks a fraction of a second apart are both
 * quoted against the same starting balance.
 */
export class ConcurrentTradeError extends Error {
  constructor(readonly what: 'balance' | 'position') {
    super(
      what === 'balance'
        ? 'the account balance changed while this trade was in flight'
        : 'the position changed while this trade was in flight',
    );
    this.name = 'ConcurrentTradeError';
  }
}

export async function recordTrade(
  db: Client,
  input: {
    readonly snapshot: PoolSnapshotWrite;
    readonly trade: Omit<TradeWrite, 'poolSnapshotId' | 'leafHash'>;
    readonly position: PositionWrite;
    /**
     * The state the fill was quoted against.
     *
     * Every write below is conditional on this still being true. Without it
     * `newBalance` is an absolute figure derived from a read that may be
     * hundreds of milliseconds old, and two concurrent trades both write the
     * same "after" balance — which is how a trader buys twice with one
     * balance and mints the practice SOL the leaderboard ranks on.
     */
    readonly expected: {
      readonly solBalance: string;
      /** Tokens held before this fill. Null when there was no open position. */
      readonly tokenAmount: string | null;
    };
    readonly newBalance: string;
    /**
     * Produces the leaf hash once the sequence is known.
     *
     * A callback rather than a value because the sequence is only settled
     * inside this transaction, and the leaf commits to it. Hashing beforehand
     * would mean hashing a number that had not been decided.
     */
    readonly leafHashFor: (sequence: number) => string;
    readonly now: number;
  },
): Promise<{ id: number; sequence: number }> {
  const tx = await db.transaction('write');

  try {
    // The same pool at the same slot may already be recorded by another
    // trader's fill, and two rows would be two different snapshots of one
    // moment.
    const snapshot = await tx.execute({
      sql: `INSERT INTO pool_snapshots
              (mint, sol_reserve, token_reserve, deliverable_tokens, token_decimals,
               fee_bps, source, slot, observed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mint, slot) DO UPDATE SET observed_at = observed_at
            RETURNING id`,
      args: [
        input.snapshot.mint,
        input.snapshot.solReserve,
        input.snapshot.tokenReserve,
        input.snapshot.deliverableTokens,
        input.snapshot.tokenDecimals,
        input.snapshot.feeBps,
        input.snapshot.source,
        input.snapshot.slot,
        input.now,
      ],
    });
    const snapshotId = Number(snapshot.rows[0]!['id']);

    // Settled here, inside the transaction, so it cannot be read by two
    // trades at once. The unique index enforces that if it ever were.
    const last = await tx.execute({
      sql: 'SELECT COALESCE(MAX(sequence), 0) AS last FROM trades WHERE account_id = ?',
      args: [input.trade.accountId],
    });
    const sequence = Number(last.rows[0]!['last']) + 1;

    const trade = await tx.execute({
      sql: `INSERT INTO trades (
              account_id, season_id, user_pubkey, mint, side, sol_amount, token_amount,
              fee, price_impact_bps, partial, pool_source, clicked_at_slot, filled_at_slot,
              latency_ms, engine_version, pool_snapshot_id, leaf_hash, sequence, created_at,
              source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id`,
      args: [
        input.trade.accountId,
        input.trade.seasonId,
        input.trade.userPubkey,
        input.trade.mint,
        input.trade.side,
        input.trade.solAmount,
        input.trade.tokenAmount,
        input.trade.fee,
        input.trade.priceImpactBps,
        input.trade.partial ? 1 : 0,
        input.trade.poolSource,
        input.trade.clickedAtSlot,
        input.trade.filledAtSlot,
        input.trade.latencyMs,
        input.trade.engineVersion,
        snapshotId,
        input.leafHashFor(sequence),
        sequence,
        input.now,
        input.trade.source ?? 'web',
      ],
    });

    // Compare and swap. If the balance is no longer the one the fill was
    // quoted against, another trade landed first and this one is void — the
    // whole transaction rolls back rather than overwriting their result.
    const balanceUpdate = await tx.execute({
      sql: `UPDATE accounts SET sol_balance = ?, updated_at = ?
            WHERE id = ? AND sol_balance = ?`,
      args: [input.newBalance, input.now, input.trade.accountId, input.expected.solBalance],
    });
    if (Number(balanceUpdate.rowsAffected) !== 1) {
      throw new ConcurrentTradeError('balance');
    }

    const existing = await tx.execute({
      sql: `SELECT id FROM positions WHERE account_id = ? AND mint = ? AND closed_at IS NULL
            ORDER BY opened_at DESC LIMIT 1`,
      args: [input.position.accountId, input.position.mint],
    });

    if (existing.rows[0]) {
      // The balance alone is not enough: a concurrent sell can leave the
      // balance exactly where this fill expected it while emptying the
      // holding it was computed against.
      const positionUpdate = await tx.execute({
        sql: `UPDATE positions SET token_amount = ?, cost_basis = ?, realized_pnl = ?,
                closed_at = ?, updated_at = ? WHERE id = ? AND token_amount = ?`,
        args: [
          input.position.tokenAmount,
          input.position.costBasis,
          input.position.realizedPnl,
          input.position.closed ? input.now : null,
          input.now,
          Number(existing.rows[0]['id']),
          input.expected.tokenAmount ?? '0',
        ],
      });
      if (Number(positionUpdate.rowsAffected) !== 1) {
        throw new ConcurrentTradeError('position');
      }
    } else {
      // No open row, so the fill must have been quoted against holding
      // nothing. If it expected tokens, the position was closed underneath it.
      if (input.expected.tokenAmount !== null && input.expected.tokenAmount !== '0') {
        throw new ConcurrentTradeError('position');
      }
      await tx.execute({
        sql: `INSERT INTO positions
                (account_id, mint, token_amount, cost_basis, realized_pnl, opened_at, closed_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          input.position.accountId,
          input.position.mint,
          input.position.tokenAmount,
          input.position.costBasis,
          input.position.realizedPnl,
          input.now,
          input.position.closed ? input.now : null,
          input.now,
        ],
      });
    }

    await tx.commit();
    return { id: Number(trade.rows[0]!['id']), sequence };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/** Every open position on an account. */
export async function openPositions(db: Client, accountId: number): Promise<PositionRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM positions WHERE account_id = ? AND closed_at IS NULL AND token_amount != '0'
          ORDER BY opened_at DESC`,
    args: [accountId],
  });

  return result.rows.map((row) => ({
    id: Number(row['id']),
    mint: String(row['mint']),
    tokenAmount: String(row['token_amount']),
    costBasis: String(row['cost_basis']),
    realizedPnl: String(row['realized_pnl']),
    openedAt: Number(row['opened_at']),
  }));
}

/**
 * Realized profit and loss across every position the account has ever held.
 *
 * Includes closed ones deliberately. A trader who bought well, sold and moved
 * on has realized that money, and a total drawn only from open positions would
 * show them having made nothing.
 */
export async function totalRealizedPnl(db: Client, accountId: number): Promise<string> {
  const result = await db.execute({
    sql: 'SELECT realized_pnl FROM positions WHERE account_id = ?',
    args: [accountId],
  });

  // Summed in bigint rather than SQL, because these are digit strings and
  // SQLite would coerce them through a float to add them.
  const total = result.rows.reduce(
    (sum, row) => sum + BigInt(String(row['realized_pnl'])),
    0n,
  );
  return total.toString();
}

export interface TradeRow {
  readonly id: number;
  readonly sequence: number;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly fee: string;
  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly latencyMs: number;
  readonly engineVersion: number;
  readonly leafHash: string;
  readonly createdAt: number;
}

/** The trade log, newest first. Append-only, so this is the whole story. */
export async function tradeHistory(
  db: Client,
  accountId: number,
  limit = 100,
  mint?: string,
): Promise<TradeRow[]> {
  const result = await db.execute(
    mint
      ? {
          sql: `SELECT * FROM trades WHERE account_id = ? AND mint = ?
                ORDER BY id DESC LIMIT ?`,
          args: [accountId, mint, limit],
        }
      : {
          sql: 'SELECT * FROM trades WHERE account_id = ? ORDER BY id DESC LIMIT ?',
          args: [accountId, limit],
        },
  );

  return result.rows.map((row) => toTradeRow(row as unknown as Record<string, unknown>));
}

/** A fill as the tape shows it: whose it was, and how it was produced. */
export interface TapeRow extends TradeRow {
  readonly pubkey: string;
  readonly poolSource: string;
}

/**
 * The newest fills across every account.
 *
 * Every other reader here is scoped to one account, because every other caller
 * is showing somebody their own log. This one is for the broadcast, where the
 * point is that fills are landing at all and that each carries the hash it was
 * sealed with.
 *
 * The pubkey travels with the row and is truncated by whoever renders it. A
 * wallet address is already public and already on the leaderboard, so this
 * exposes nothing that reading the chain would not, but a full key across a
 * stream is thirty-two characters of noise nobody can act on.
 */
export async function recentTrades(db: Client, limit = 40): Promise<TapeRow[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM trades ORDER BY id DESC LIMIT ?',
    args: [limit],
  });

  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      ...toTradeRow(row),
      pubkey: String(row['user_pubkey']),
      poolSource: String(row['pool_source']),
    };
  });
}

function toTradeRow(row: Record<string, unknown>): TradeRow {
  return {
    id: Number(row['id']),
    sequence: Number(row['sequence']),
    mint: String(row['mint']),
    side: String(row['side']) as 'buy' | 'sell',
    solAmount: String(row['sol_amount']),
    tokenAmount: String(row['token_amount']),
    fee: String(row['fee']),
    priceImpactBps: Number(row['price_impact_bps']),
    partial: Number(row['partial']) === 1,
    latencyMs: Number(row['latency_ms']),
    engineVersion: Number(row['engine_version']),
    leafHash: String(row['leaf_hash']),
    createdAt: Number(row['created_at']),
  };
}

/**
 * Every trade an account has made, oldest first.
 *
 * Separate from `tradeHistory`, which pages backwards for a UI. Analytics has
 * to replay from the beginning — starting halfway through a log means starting
 * mid-position, and every statistic after that is drawn from a position whose
 * cost basis was never established.
 */
export async function allTrades(db: Client, accountId: number): Promise<TradeRow[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM trades WHERE account_id = ? ORDER BY sequence ASC, id ASC',
    args: [accountId],
  });
  return result.rows.map((row) => toTradeRow(row as unknown as Record<string, unknown>));
}

/** Whether a season is ranked. Decides which coaching allowance applies. */
export async function isRankedSeason(db: Client, seasonId: number): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT ranked FROM seasons WHERE id = ?',
    args: [seasonId],
  });
  return Number(result.rows[0]?.['ranked'] ?? 0) === 1;
}

/**
 * The ranked season currently accepting entries, if any.
 *
 * Decided by the clock, not by the stored status column. That column is a
 * record of what was last written; the window is a fact about the time. A
 * season whose status was never advanced by some job would otherwise never open
 * for entry at all, and the failure would be silent — the season simply never
 * sells a ticket.
 *
 * `finalized` is the one status that overrides the clock, because it is an
 * event rather than a time: a season whose results are on chain is over
 * regardless of what its end date says.
 */
export async function openRankedSeason(db: Client, now: number): Promise<SeasonRow | null> {
  const result = await db.execute({
    sql: `SELECT * FROM seasons
          WHERE ranked = 1
            AND status != 'finalized'
            AND starts_at IS NOT NULL AND starts_at <= ?
            AND entry_closes_at IS NOT NULL AND entry_closes_at > ?
            AND (ends_at IS NULL OR ends_at > ?)
          ORDER BY ordinal DESC LIMIT 1`,
    args: [now, now, now],
  });
  const row = result.rows[0];
  return row ? toSeasonRow(row as unknown as Record<string, unknown>) : null;
}

export interface SeasonRow {
  readonly id: number;
  readonly ordinal: number;
  readonly name: string;
  readonly ranked: boolean;
  readonly status: string;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly entryOpensAt: number | null;
  readonly entryClosesAt: number | null;
  readonly startingBalance: string;
  readonly entryCost: string;
  /**
   * The ruleset hash recorded when the season was created.
   *
   * Read, never recomputed. Recomputing it from today's code would mean a
   * future change to the rules silently rewrites the hash a running season
   * published — which is the exact thing the hash exists to prevent.
   */
  readonly rulesetHash: string;
}

function toSeasonRow(row: Record<string, unknown>): SeasonRow {
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
    rulesetHash: String(row['scoring_formula_hash']),
  };
}

/**
 * Every token somebody on this site is currently holding.
 *
 * The leaderboard has to mark these at something, and the price for them has to
 * come from somewhere. The curve watcher follows new launches and the price feed
 * follows whatever a visitor has open on screen, so a token that is only held
 * and not being looked at had nothing keeping its price current: twenty-three of
 * about thirty open positions had no recent candle at all, were marked at what
 * they cost, and every row on the board sat on the balance it started with.
 *
 * This is the list that answers "what does the site owe a price for".
 */
export async function heldMints(db: Client): Promise<string[]> {
  const result = await db.execute(
    `SELECT DISTINCT mint FROM positions
     WHERE closed_at IS NULL AND token_amount != '0'`,
  );
  return result.rows.map((row) => String(row['mint']));
}

/**
 * Whether an account is out of road.
 *
 * Broke is not a zero balance. It is a balance too small to open anything with,
 * while holding nothing worth selling, which is a state the site had no answer
 * for at all: the store sells practice balance and buying it counts against the
 * return by design, so the only way back was to pay and lose your rank for it.
 */
export async function isSpent(
  db: Client,
  accountId: number,
  floor: bigint,
): Promise<boolean> {
  const account = await db.execute({
    sql: 'SELECT sol_balance FROM accounts WHERE id = ?',
    args: [accountId],
  });
  const row = account.rows[0];
  if (!row) return false;
  if (BigInt(String(row['sol_balance'])) >= floor) return false;

  const open = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM positions
          WHERE account_id = ? AND closed_at IS NULL AND token_amount != '0'`,
    args: [accountId],
  });
  return Number(open.rows[0]?.['n'] ?? 0) === 0;
}

/**
 * Start a free-play account again, at the season's opening balance.
 *
 * A new generation rather than a reset of the old row, which is what the schema
 * was built for and what nothing ever did: the column existed, the comment on
 * FREE_PLAY_ORDINAL described it, and no code path incremented it. A trader who
 * ran out simply stopped, permanently, holding whatever was left.
 *
 * Nothing is deleted or edited. The old account keeps its trades, its positions
 * and its sealed record exactly as they were, because a record that can be
 * wiped by going broke is not a record. The new generation is a new account
 * beside it, and the board shows both.
 *
 * Ranked seasons are refused outright. Somebody who paid to enter and blew up
 * does not get another ten SOL to try again on, and a function that could do
 * that by being called with the wrong id has no business existing.
 */
export async function startOver(
  db: Client,
  seasonId: number,
  userPubkey: string,
  now: number,
): Promise<AccountRow> {
  const season = await db.execute({
    sql: 'SELECT * FROM seasons WHERE id = ?',
    args: [seasonId],
  });
  const seasonRow = season.rows[0];
  if (!seasonRow) throw new Error(`no season ${seasonId}`);
  if (Number(seasonRow['ordinal']) !== FREE_PLAY_ORDINAL) {
    throw new Error('only free play can be started over');
  }

  const previous = await db.execute({
    sql: `SELECT generation FROM accounts WHERE season_id = ? AND user_pubkey = ?
          ORDER BY generation DESC LIMIT 1`,
    args: [seasonId, userPubkey],
  });
  const generation = Number(previous.rows[0]?.['generation'] ?? -1) + 1;

  await db.execute({
    sql: `INSERT INTO accounts (season_id, user_pubkey, generation, sol_balance, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (season_id, user_pubkey, generation) DO NOTHING`,
    args: [seasonId, userPubkey, generation, String(seasonRow['starting_balance']), now, now],
  });

  return ensureAccount(db, seasonId, userPubkey, now);
}
