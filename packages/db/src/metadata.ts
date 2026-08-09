import type { Client } from '@libsql/client';

/**
 * The token metadata cache.
 *
 * Names and symbols change rarely and are read constantly — a discovery feed
 * touches hundreds per screen — so they are cached rather than re-fetched. The
 * on-chain and off-chain halves are written separately because they fail
 * separately.
 */

export interface CachedTokenMetadata {
  readonly mint: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly uri: string | null;
  readonly updateAuthority: string | null;
  readonly decimals: number | null;
  readonly onchainFetchedAt: number;
  readonly offchainName: string | null;
  readonly offchainSymbol: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly offchainFetchedAt: number | null;
  readonly offchainError: string | null;
}

function toRow(row: Record<string, unknown>): CachedTokenMetadata {
  const text = (key: string): string | null =>
    row[key] === null || row[key] === undefined ? null : String(row[key]);
  const num = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);

  return {
    mint: String(row['mint']),
    name: text('name'),
    symbol: text('symbol'),
    uri: text('uri'),
    updateAuthority: text('update_authority'),
    decimals: num('decimals'),
    onchainFetchedAt: Number(row['onchain_fetched_at']),
    offchainName: text('offchain_name'),
    offchainSymbol: text('offchain_symbol'),
    description: text('description'),
    imageUrl: text('image_url'),
    offchainFetchedAt: num('offchain_fetched_at'),
    offchainError: text('offchain_error'),
  };
}

export async function getTokenMetadata(
  db: Client,
  mint: string,
): Promise<CachedTokenMetadata | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM token_metadata WHERE mint = ?',
    args: [mint],
  });
  const row = result.rows[0];
  return row ? toRow(row as unknown as Record<string, unknown>) : null;
}

export async function getManyTokenMetadata(
  db: Client,
  mints: readonly string[],
): Promise<Map<string, CachedTokenMetadata>> {
  if (mints.length === 0) return new Map();

  const placeholders = mints.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT * FROM token_metadata WHERE mint IN (${placeholders})`,
    args: [...mints],
  });

  const found = new Map<string, CachedTokenMetadata>();
  for (const row of result.rows) {
    const entry = toRow(row as unknown as Record<string, unknown>);
    found.set(entry.mint, entry);
  }
  return found;
}

export interface OnchainMetadataWrite {
  readonly mint: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly uri: string | null;
  readonly updateAuthority: string | null;
  readonly decimals: number | null;
}

/**
 * Record what the chain says.
 *
 * Deliberately leaves the off-chain columns alone: metadata is mutable, and a
 * token whose name changed on chain should not lose a perfectly good cached
 * image because of it. The off-chain half is refreshed on its own schedule.
 */
export async function upsertOnchainMetadata(
  db: Client,
  entry: OnchainMetadataWrite,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO token_metadata
            (mint, name, symbol, uri, update_authority, decimals, onchain_fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (mint) DO UPDATE SET
            name = excluded.name,
            symbol = excluded.symbol,
            uri = excluded.uri,
            update_authority = excluded.update_authority,
            decimals = excluded.decimals,
            onchain_fetched_at = excluded.onchain_fetched_at`,
    args: [
      entry.mint,
      entry.name,
      entry.symbol,
      entry.uri,
      entry.updateAuthority,
      entry.decimals,
      now,
    ],
  });
}

export interface OffchainMetadataWrite {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
}

export async function recordOffchainMetadata(
  db: Client,
  mint: string,
  entry: OffchainMetadataWrite,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE token_metadata SET
            offchain_name = ?, offchain_symbol = ?, description = ?, image_url = ?,
            offchain_fetched_at = ?, offchain_error = NULL
          WHERE mint = ?`,
    args: [entry.name, entry.symbol, entry.description, entry.imageUrl, now, mint],
  });
}

/**
 * Record that the off-chain fetch failed.
 *
 * Stamping the timestamp on failure as well as success is what stops a token
 * with a dead gateway from being retried on every single page load.
 */
export async function recordOffchainFailure(
  db: Client,
  mint: string,
  error: string,
  now: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE token_metadata SET offchain_fetched_at = ?, offchain_error = ?
          WHERE mint = ?`,
    args: [now, error.slice(0, 500), mint],
  });
}

/** Mints whose off-chain document has never been fetched, or is older than `staleBefore`. */
export async function staleOffchainMints(
  db: Client,
  staleBefore: number,
  limit: number,
): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT mint FROM token_metadata
          WHERE uri IS NOT NULL
            AND (offchain_fetched_at IS NULL OR offchain_fetched_at < ?)
          ORDER BY offchain_fetched_at IS NOT NULL, offchain_fetched_at
          LIMIT ?`,
    args: [staleBefore, limit],
  });
  return result.rows.map((row) => String(row['mint']));
}

/**
 * The name to actually show.
 *
 * On-chain wins. It is the harder thing to change — it costs a transaction and
 * the update authority — whereas the off-chain document can be swapped silently
 * at any moment by whoever controls the host.
 */
export function displayName(entry: CachedTokenMetadata): string {
  return entry.name ?? entry.offchainName ?? entry.mint.slice(0, 4);
}

export function displaySymbol(entry: CachedTokenMetadata): string {
  return entry.symbol ?? entry.offchainSymbol ?? '???';
}
