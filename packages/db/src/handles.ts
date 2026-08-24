import type { Client } from './client';

/**
 * The X account a token names, and how many other tokens name it too.
 *
 * The honest half of "has this account shilled a pile of coins". Seeing what an
 * account posted and then deleted needs an archive nobody here keeps. Seeing
 * that the same account is attached to eleven other launches in this site's own
 * index needs only the index.
 */

/**
 * The account out of an X link, or null if it names none.
 *
 * Normalised because the same account is written a dozen ways, and grouping the
 * raw URLs would count each spelling separately — which turns one serial
 * promoter into eleven first-timers, exactly inverting the signal.
 *
 * A link to a single post is deliberately not an account. Plenty of tokens
 * point their "twitter" at one message in somebody else's thread, which says
 * nothing about who is behind the token and would otherwise credit them with a
 * stranger's history.
 */
export function twitterHandle(url: string | null | undefined): string | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.twitter.com') return null;

  const parts = parsed.pathname.split('/').filter((part) => part.length > 0);
  const handle = parts[0]?.toLowerCase();
  if (!handle) return null;

  // A post, a search, a hashtag: not an account.
  if (parts.length > 1 && parts[1] !== undefined && parts[1] !== '') {
    if (parts[1].toLowerCase() === 'status' || parts[1].toLowerCase() === 'statuses') return null;
  }
  if (['i', 'search', 'hashtag', 'intent', 'home', 'explore'].includes(handle)) return null;
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return null;

  return handle;
}

/** Fill in the handle for rows that have a link and no handle read from it yet. */
export async function backfillTwitterHandles(db: Client, limit = 500): Promise<number> {
  const rows = await db.execute({
    sql: `SELECT mint, twitter_url FROM token_metadata
          WHERE twitter_url IS NOT NULL AND twitter_url != '' AND twitter_handle IS NULL
          LIMIT ?`,
    args: [limit],
  });

  let written = 0;
  for (const row of rows.rows) {
    const handle = twitterHandle(String(row['twitter_url']));
    if (handle === null) continue;
    await db.execute({
      sql: 'UPDATE token_metadata SET twitter_handle = ? WHERE mint = ?',
      args: [handle, String(row['mint'])],
    });
    written += 1;
  }
  return written;
}

/**
 * How many tokens in this index name each of these mints' X accounts.
 *
 * Counted over the whole index, and including the token itself, so one is a
 * token whose account has been seen once: this one. Absent from the map means
 * the token names no account at all.
 */
export async function socialReuseFor(
  db: Client,
  mints: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;

  const unique = [...new Set(mints)];
  const holes = unique.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT m.mint AS mint, (
            SELECT COUNT(*) FROM token_metadata other
            WHERE other.twitter_handle = m.twitter_handle
          ) AS uses
          FROM token_metadata m
          WHERE m.mint IN (${holes}) AND m.twitter_handle IS NOT NULL`,
    args: unique,
  });

  for (const row of result.rows) {
    out.set(String(row['mint']), Number(row['uses']));
  }
  return out;
}
