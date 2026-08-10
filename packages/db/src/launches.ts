import type { Client } from '@libsql/client';

/**
 * The launch feed and the search over it.
 */

export interface Launch {
  readonly mint: string;
  readonly bondingCurve: string;
  readonly creator: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly launchedAt: number;
  readonly slot: number | null;
  readonly firstSeenAt: number;
}

function toLaunch(row: Record<string, unknown>): Launch {
  return {
    mint: String(row['mint']),
    bondingCurve: String(row['bonding_curve']),
    creator: String(row['creator']),
    name: String(row['name']),
    symbol: String(row['symbol']),
    uri: String(row['uri']),
    launchedAt: Number(row['launched_at']),
    slot: row['slot'] === null || row['slot'] === undefined ? null : Number(row['slot']),
    firstSeenAt: Number(row['first_seen_at']),
  };
}

/**
 * Record launches.
 *
 * Idempotent on the mint, because a reconnecting stream replays recent history
 * and a launch seen twice is not a second launch. The first sighting is kept
 * rather than overwritten, since when we noticed is a fact about us and the
 * launch time is a fact about the token.
 */
export async function recordLaunches(
  db: Client,
  launches: readonly Omit<Launch, 'firstSeenAt'>[],
  now: number,
): Promise<number> {
  if (launches.length === 0) return 0;

  const result = await db.batch(
    launches.map((launch) => ({
      sql: `INSERT INTO launches
              (mint, bonding_curve, creator, name, symbol, uri, launched_at, slot, first_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mint) DO NOTHING`,
      args: [
        launch.mint,
        launch.bondingCurve,
        launch.creator,
        launch.name,
        launch.symbol,
        launch.uri,
        launch.launchedAt,
        launch.slot,
        now,
      ],
    })),
    'write',
  );

  return result.reduce((sum, one) => sum + Number(one.rowsAffected), 0);
}

/** The feed: newest launches first. */
export async function recentLaunches(db: Client, limit = 50): Promise<Launch[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM launches ORDER BY launched_at DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.map((row) => toLaunch(row as unknown as Record<string, unknown>));
}

export async function launchByMint(db: Client, mint: string): Promise<Launch | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM launches WHERE mint = ?',
    args: [mint],
  });
  const row = result.rows[0];
  return row ? toLaunch(row as unknown as Record<string, unknown>) : null;
}

/**
 * Search by what someone actually typed.
 *
 * A full mint address is matched exactly and returned alone — someone pasting
 * one wants that token, not everything whose name happens to contain it.
 * Otherwise it is a prefix match on symbol and a contains match on name, with
 * exact symbol matches first.
 *
 * The query is escaped for LIKE, so a token called "100%" cannot turn a search
 * into a wildcard that returns the whole table.
 */
export async function searchLaunches(
  db: Client,
  query: string,
  limit = 25,
): Promise<Launch[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
    const exact = await launchByMint(db, trimmed);
    return exact ? [exact] : [];
  }

  const escaped = trimmed.replace(/[\\%_]/g, (match) => `\\${match}`);

  const result = await db.execute({
    sql: `SELECT * FROM launches
          WHERE symbol LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
          ORDER BY
            CASE WHEN LOWER(symbol) = LOWER(?) THEN 0 ELSE 1 END,
            launched_at DESC
          LIMIT ?`,
    args: [`${escaped}%`, `%${escaped}%`, trimmed, limit],
  });

  return result.rows.map((row) => toLaunch(row as unknown as Record<string, unknown>));
}

/** Everything a given wallet has launched. */
export async function launchesByCreator(
  db: Client,
  creator: string,
  limit = 50,
): Promise<Launch[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM launches WHERE creator = ? ORDER BY launched_at DESC LIMIT ?',
    args: [creator, limit],
  });
  return result.rows.map((row) => toLaunch(row as unknown as Record<string, unknown>));
}

/**
 * How many tokens each of these wallets has launched.
 *
 * A creator's history is the cheapest rug signal there is. Somebody on their
 * first launch is an unknown; somebody on their fortieth, all of which went to
 * zero, is a pattern — and it costs one query over data already recorded.
 *
 * Counts what this feed has seen, which is not the same as what the wallet has
 * ever done. A creator whose earlier tokens predate our index reads as newer
 * than they are, so this is a floor on their history rather than the whole of
 * it, and is presented that way.
 */
export async function creatorLaunchCounts(
  db: Client,
  creators: readonly string[],
): Promise<Map<string, number>> {
  if (creators.length === 0) return new Map();

  const unique = [...new Set(creators)];
  const placeholders = unique.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT creator, COUNT(*) AS n FROM launches
          WHERE creator IN (${placeholders})
          GROUP BY creator`,
    args: [...unique],
  });

  return new Map(result.rows.map((row) => [String(row['creator']), Number(row['n'])]));
}
