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
  /** A prize put up rather than paid for by entries. Lamports, as digits. */
  readonly sponsorLamports?: string;
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
             latency_ms, max_price_impact_bps, engine_version, scoring_formula_hash,
             sponsor_lamports, created_at)
          VALUES (?, ?, 1, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.sponsorLamports ?? '0',
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
  /** Entries plus any sponsored prize. What the season actually pays out. */
  readonly potLamports: bigint;
  /** The part the entrants paid, and the part they are owed back if it voids. */
  readonly entriesLamports: bigint;
  /** The part somebody put up. Never refundable, because it was never theirs. */
  readonly sponsorLamports: bigint;
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

  let entries = 0n;
  for (const row of payments.rows) entries += BigInt(String(row['amount']));

  const sponsored = await db.execute({
    sql: 'SELECT sponsor_lamports FROM seasons WHERE id = ?',
    args: [seasonId],
  });
  const sponsor = BigInt(String(sponsored.rows[0]?.['sponsor_lamports'] ?? '0'));

  return {
    entrants: Number(entrants.rows[0]?.['n'] ?? 0),
    potLamports: entries + sponsor,
    entriesLamports: entries,
    sponsorLamports: sponsor,
  };
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
    rulesetHash: String(row['scoring_formula_hash']),
  };
}

export interface LeaderboardPosition {
  readonly mint: string;
  readonly tokenAmount: string;
  readonly costBasis: string;
}

export interface LeaderboardRow {
  readonly accountId: number;
  readonly userPubkey: string;
  readonly startingBalance: string;
  readonly solBalance: string;
  readonly realizedPnl: string;
  readonly tradeCount: number;
  readonly enteredAt: number;
  readonly positions: readonly LeaderboardPosition[];
}

/**
 * Everything a standing needs, in three queries rather than three per trader.
 *
 * A season with five hundred entrants is five hundred accounts and rather more
 * positions. Fetching those one trader at a time is how a leaderboard becomes
 * the reason the database falls over, and the shape of the query is the only
 * thing standing between the two.
 *
 * Open positions come back attached but unpriced. Marking them needs the chain,
 * which is not this layer's business.
 */
export async function leaderboardRows(
  db: Client,
  seasonId: number,
): Promise<LeaderboardRow[]> {
  const accounts = await db.execute({
    sql: `SELECT a.id, a.user_pubkey, a.sol_balance, s.starting_balance,
                 COALESCE(e.entered_at, a.created_at) AS entered_at
          FROM accounts a
          JOIN seasons s ON s.id = a.season_id
          LEFT JOIN entries e ON e.season_id = a.season_id AND e.user_pubkey = a.user_pubkey
          WHERE a.season_id = ?`,
    args: [seasonId],
  });

  const positions = await db.execute({
    sql: `SELECT p.account_id, p.mint, p.token_amount, p.cost_basis, p.realized_pnl
          FROM positions p
          JOIN accounts a ON a.id = p.account_id
          WHERE a.season_id = ?`,
    args: [seasonId],
  });

  const counts = await db.execute({
    sql: `SELECT account_id, COUNT(*) AS n FROM trades
          WHERE season_id = ? GROUP BY account_id`,
    args: [seasonId],
  });

  const held = new Map<number, LeaderboardPosition[]>();
  const realized = new Map<number, bigint>();
  for (const row of positions.rows) {
    const accountId = Number(row['account_id']);
    // Realized profit accumulates on the position row and survives it being
    // closed, so it is summed across every position rather than only open ones.
    realized.set(accountId, (realized.get(accountId) ?? 0n) + BigInt(String(row['realized_pnl'])));

    if (BigInt(String(row['token_amount'])) === 0n) continue;
    const list = held.get(accountId) ?? [];
    list.push({
      mint: String(row['mint']),
      tokenAmount: String(row['token_amount']),
      costBasis: String(row['cost_basis']),
    });
    held.set(accountId, list);
  }

  const tradeCounts = new Map<number, number>();
  for (const row of counts.rows) {
    tradeCounts.set(Number(row['account_id']), Number(row['n']));
  }

  return accounts.rows.map((row) => {
    const accountId = Number(row['id']);
    return {
      accountId,
      userPubkey: String(row['user_pubkey']),
      startingBalance: String(row['starting_balance']),
      solBalance: String(row['sol_balance']),
      realizedPnl: (realized.get(accountId) ?? 0n).toString(),
      tradeCount: tradeCounts.get(accountId) ?? 0,
      enteredAt: Number(row['entered_at']),
      positions: held.get(accountId) ?? [],
    };
  });
}
