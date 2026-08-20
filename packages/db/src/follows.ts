import type { Client } from '@libsql/client';

/**
 * Following, and the audience a record earns.
 *
 * Deliberately thin. A follow is a row, a count is a count, and none of it
 * touches money, a season or a fill. The interesting part of this feature is
 * not the graph, it is that the trades an audience turns up to watch are the
 * same sealed trades anybody can verify. So this file stays boring and the
 * value stays in the record.
 */

export interface FollowCounts {
  readonly followers: number;
  readonly following: number;
}

export interface FollowedTrade {
  readonly id: number;
  readonly trader: string;
  readonly mint: string;
  /** The token's name and ticker, when this database happens to know them. */
  readonly name: string | null;
  readonly symbol: string | null;
  readonly image: string | null;
  readonly side: 'buy' | 'sell';
  readonly solAmount: string;
  readonly tokenAmount: string;
  readonly priceImpactBps: number;
  readonly latencyMs: number;
  readonly createdAt: number;
}

/*
 * The token's name comes along with the fill.
 *
 * A spectator watching somebody trade needs to see what they bought, and a
 * feed that emitted a bare mint would need a second request per row to become
 * readable. Left joined, because retention prunes launches after a fortnight
 * and metadata is fetched on demand, so either side can be missing and a fill
 * with no name is still a fill worth showing.
 */
const TOKEN_JOIN = `
  LEFT JOIN token_metadata m ON m.mint = t.mint
  LEFT JOIN launches l ON l.mint = t.mint`;

const TOKEN_COLUMNS = `
  COALESCE(m.offchain_name, m.name, l.name) AS token_name,
  COALESCE(m.offchain_symbol, m.symbol, l.symbol) AS token_symbol,
  m.image_url AS token_image`;

/**
 * Start following. Doing it twice is the same as doing it once.
 *
 * `ON CONFLICT DO NOTHING` rather than an error, because the button is idempotent
 * from the caller's point of view and a double tap on a phone should not be a
 * failure anybody has to see.
 */
export async function follow(
  db: Client,
  follower: string,
  followed: string,
  now: number,
): Promise<void> {
  if (follower === followed) return;
  await db.execute({
    sql: `INSERT INTO follows (follower_pubkey, followed_pubkey, created_at)
          VALUES (?, ?, ?)
          ON CONFLICT (follower_pubkey, followed_pubkey) DO NOTHING`,
    args: [follower, followed, now],
  });
}

export async function unfollow(db: Client, follower: string, followed: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM follows WHERE follower_pubkey = ? AND followed_pubkey = ?',
    args: [follower, followed],
  });
}

export async function isFollowing(
  db: Client,
  follower: string,
  followed: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT 1 FROM follows WHERE follower_pubkey = ? AND followed_pubkey = ? LIMIT 1',
    args: [follower, followed],
  });
  return result.rows.length > 0;
}

/** Both numbers for one wallet, in a single round trip. */
export async function followCounts(db: Client, pubkey: string): Promise<FollowCounts> {
  const result = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM follows WHERE followed_pubkey = ?) AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_pubkey = ?) AS following`,
    args: [pubkey, pubkey],
  });
  const row = result.rows[0];
  return {
    followers: Number(row?.['followers'] ?? 0),
    following: Number(row?.['following'] ?? 0),
  };
}

/** A wallet in a follower or following list, with a name when it has one. */
export interface FollowEntry {
  readonly pubkey: string;
  readonly name: string | null;
  readonly followedAt: number;
}

/**
 * The audience, or who somebody follows, with names attached.
 *
 * Names come from the same join rather than a second pass, because a list of
 * two hundred addresses would otherwise be two hundred lookups to render, and
 * the point of the list is that it is readable.
 */
async function entries(
  db: Client,
  column: 'follower_pubkey' | 'followed_pubkey',
  match: 'follower_pubkey' | 'followed_pubkey',
  pubkey: string,
  limit: number,
): Promise<FollowEntry[]> {
  const result = await db.execute({
    sql: `SELECT f.${column} AS pubkey, f.created_at, d.name
          FROM follows f
          LEFT JOIN display_names d
            ON d.user_pubkey = f.${column} AND d.cleared_at IS NULL
          WHERE f.${match} = ?
          ORDER BY f.created_at DESC
          LIMIT ?`,
    args: [pubkey, Math.min(Math.max(limit, 1), 200)],
  });
  return result.rows.map((row) => ({
    pubkey: String(row['pubkey']),
    name: row['name'] === null ? null : String(row['name']),
    followedAt: Number(row['created_at']),
  }));
}

/** Who follows this wallet, most recent first. */
export async function followerList(
  db: Client,
  pubkey: string,
  limit = 100,
): Promise<FollowEntry[]> {
  return entries(db, 'follower_pubkey', 'followed_pubkey', pubkey, limit);
}

/** Who this wallet follows, most recent first. */
export async function followingList(
  db: Client,
  pubkey: string,
  limit = 100,
): Promise<FollowEntry[]> {
  return entries(db, 'followed_pubkey', 'follower_pubkey', pubkey, limit);
}

/**
 * How many followers arrived since this trader last looked.
 *
 * Derived from the follow's own timestamp against a single mark on the user,
 * rather than a row per notification. A notification table would grow forever
 * to store something the follow already knows, and would need its own pruning.
 */
export async function newFollowerCount(db: Client, pubkey: string): Promise<number> {
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM follows
          WHERE followed_pubkey = ?
            AND created_at > COALESCE(
              (SELECT seen_at FROM follow_reads WHERE pubkey = ?), 0)`,
    args: [pubkey, pubkey],
  });
  return Number(result.rows[0]?.['n'] ?? 0);
}

/**
 * Mark the audience as seen, up to now.
 *
 * Never moves backwards. Two tabs open on the same account would otherwise let
 * the older response undo the newer one and resurrect a notification somebody
 * has already read.
 */
export async function markFollowersSeen(db: Client, pubkey: string, now: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO follow_reads (pubkey, seen_at) VALUES (?, ?)
          ON CONFLICT (pubkey) DO UPDATE SET seen_at = excluded.seen_at
          WHERE follow_reads.seen_at < excluded.seen_at`,
    args: [pubkey, now],
  });
}

/** The wallets this one follows, most recently followed first. */
export async function following(db: Client, pubkey: string, limit = 200): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT followed_pubkey FROM follows
          WHERE follower_pubkey = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [pubkey, limit],
  });
  return result.rows.map((row) => String(row['followed_pubkey']));
}

/** The audience, most recent first. */
export async function followers(db: Client, pubkey: string, limit = 200): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT follower_pubkey FROM follows
          WHERE followed_pubkey = ?
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [pubkey, limit],
  });
  return result.rows.map((row) => String(row['follower_pubkey']));
}

/**
 * Recent fills by the wallets somebody follows.
 *
 * Joined rather than fetched per trader, because a feed built with one query
 * per followed wallet is a hundred queries for somebody with a hundred follows,
 * and it gets slower exactly as somebody uses the feature more.
 *
 * `after` is a trade id rather than a timestamp. Two fills can land in the same
 * millisecond, and a timestamp cursor either shows one of them twice or drops
 * it. Ids are unique and monotonic, so the stream can resume exactly.
 */
export async function followedTrades(
  db: Client,
  pubkey: string,
  options: { readonly after?: number; readonly limit?: number } = {},
): Promise<FollowedTrade[]> {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
  const after = options.after ?? 0;
  const result = await db.execute({
    sql: `SELECT t.id, t.user_pubkey, t.mint, t.side, t.sol_amount, t.token_amount,
                 t.price_impact_bps, t.latency_ms, t.created_at,
                 ${TOKEN_COLUMNS}
          FROM trades t
          JOIN follows f ON f.followed_pubkey = t.user_pubkey
          ${TOKEN_JOIN}
          WHERE f.follower_pubkey = ? AND t.id > ?
          ORDER BY t.id DESC
          LIMIT ?`,
    args: [pubkey, after, limit],
  });
  return result.rows.map(toTrade);
}

/**
 * Recent fills by one trader, for a spectator watching a single profile.
 *
 * Same shape as the feed above so the two can share everything downstream.
 */
export async function traderTrades(
  db: Client,
  trader: string,
  options: { readonly after?: number; readonly limit?: number } = {},
): Promise<FollowedTrade[]> {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
  const after = options.after ?? 0;
  const result = await db.execute({
    sql: `SELECT t.id, t.user_pubkey, t.mint, t.side, t.sol_amount, t.token_amount,
                 t.price_impact_bps, t.latency_ms, t.created_at,
                 ${TOKEN_COLUMNS}
          FROM trades t
          ${TOKEN_JOIN}
          WHERE t.user_pubkey = ? AND t.id > ?
          ORDER BY t.id DESC
          LIMIT ?`,
    args: [trader, after, limit],
  });
  return result.rows.map(toTrade);
}

function toTrade(row: Record<string, unknown>): FollowedTrade {
  return {
    id: Number(row['id']),
    trader: String(row['user_pubkey']),
    mint: String(row['mint']),
    name: row['token_name'] === null ? null : String(row['token_name']),
    symbol: row['token_symbol'] === null ? null : String(row['token_symbol']),
    image: row['token_image'] === null ? null : String(row['token_image']),
    side: String(row['side']) === 'sell' ? 'sell' : 'buy',
    solAmount: String(row['sol_amount']),
    tokenAmount: String(row['token_amount']),
    priceImpactBps: Number(row['price_impact_bps']),
    latencyMs: Number(row['latency_ms']),
    createdAt: Number(row['created_at']),
  };
}
