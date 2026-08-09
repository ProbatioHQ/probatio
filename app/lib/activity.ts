import 'server-only';
import { recordActivity } from '@probatio/db';
import { dayNumber } from '@probatio/retention';
import type { Client } from '@libsql/client';

/**
 * Noting that a wallet was here.
 *
 * One row per wallet per day. The in-process guard is what keeps it that way:
 * without it this is a database write on every authenticated request, which is
 * a lot of work to learn something a single row already says.
 *
 * Best-effort throughout. Analytics must never be the reason a trade fails —
 * knowing whether somebody came back is worth less than letting them.
 */

const seen = new Set<string>();
/** Bounded, because a set keyed by wallet and day grows without one. */
const MAX_REMEMBERED = 20_000;

export async function noteActivity(
  client: Client,
  pubkey: string,
  traded: boolean,
  now: number,
): Promise<void> {
  const day = dayNumber(now);
  const key = `${pubkey}:${day}:${traded ? 't' : 'v'}`;

  // A trade is always written through, even if a visit was already recorded
  // today: the write is what upgrades the row, and skipping it would lose the
  // activation.
  if (seen.has(key)) return;

  try {
    await recordActivity(client, pubkey, day, traded);
    if (seen.size >= MAX_REMEMBERED) seen.clear();
    seen.add(key);
  } catch {
    // A wallet with no user row yet, or a database blip. Neither is worth
    // failing a request over.
  }
}
