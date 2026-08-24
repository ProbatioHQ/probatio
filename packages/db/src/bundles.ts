import type { Client } from './client';

/**
 * What was taken in a token's launch slot, remembered.
 *
 * The one thing a strategy can screen on whose answer never changes, so it is
 * read from the chain once per mint and answered from here forever after.
 */

export interface LaunchBundleRow {
  readonly mint: string;
  readonly slot: number | null;
  readonly bought: string | null;
  /** Null when a read was made and could not determine it. */
  readonly bundledBps: number | null;
  readonly buys: number | null;
  readonly readAt: number;
}

function toRow(row: Record<string, unknown>): LaunchBundleRow {
  return {
    mint: String(row['mint']),
    slot: row['slot'] === null ? null : Number(row['slot']),
    bought: row['bought'] === null ? null : String(row['bought']),
    bundledBps: row['bundled_bps'] === null ? null : Number(row['bundled_bps']),
    buys: row['buys'] === null ? null : Number(row['buys']),
    readAt: Number(row['read_at']),
  };
}

/** What is known for these mints. Absent means nobody has looked yet. */
export async function launchBundlesFor(
  db: Client,
  mints: readonly string[],
): Promise<Map<string, LaunchBundleRow>> {
  const out = new Map<string, LaunchBundleRow>();
  if (mints.length === 0) return out;

  const unique = [...new Set(mints)];
  const holes = unique.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT * FROM launch_bundles WHERE mint IN (${holes})`,
    args: unique,
  });
  for (const row of result.rows) {
    const parsed = toRow(row as unknown as Record<string, unknown>);
    out.set(parsed.mint, parsed);
  }
  return out;
}

/**
 * Record what a read found, including a read that found nothing.
 *
 * Storing the failure is the point. A token whose history is too long to walk
 * costs real credits to give up on, and without a row saying so it would be
 * given up on again on the next pass, and the one after that.
 */
export async function recordLaunchBundle(
  db: Client,
  input: {
    readonly mint: string;
    readonly slot: number | null;
    readonly bought: string | null;
    readonly bundledBps: number | null;
    readonly buys: number | null;
    readonly now: number;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO launch_bundles (mint, slot, bought, bundled_bps, buys, read_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (mint) DO UPDATE SET
            slot = excluded.slot,
            bought = excluded.bought,
            bundled_bps = excluded.bundled_bps,
            buys = excluded.buys,
            read_at = excluded.read_at`,
    args: [input.mint, input.slot, input.bought, input.bundledBps, input.buys, input.now],
  });
}
