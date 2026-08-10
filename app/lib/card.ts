import 'server-only';
import { allTrades, commitHistory, currentRankedSeason, ensureFreePlaySeason } from '@probatio/db';
import { computeMetrics, reconstruct } from '@probatio/analytics';
import { returnBps } from '@probatio/scoring';
import { db } from './db';
import { toLoggedTrade } from './analytics';

/**
 * The few numbers a shareable card carries.
 *
 * Deliberately the same figures the profile page shows, read the same way. A
 * card computed by its own route would eventually disagree with the page it
 * links to, and a card that overstates is worse than no card — the entire
 * reason this one is worth pasting is that it can be checked.
 */

export interface Card {
  /** Null when there is nothing closed to report. Never zero as a stand-in. */
  readonly returnBps: number | null;
  readonly trips: number;
  readonly committed: number;
  readonly rank: number | null;
  readonly entrants: number;
}

const EMPTY: Card = { returnBps: null, trips: 0, committed: 0, rank: null, entrants: 0 };

export async function cardFor(pubkey: string): Promise<Card> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) return EMPTY;

  try {
    const client = await db();
    const now = Date.now();

    const ranked = await currentRankedSeason(client, now);
    const freePlayId = await ensureFreePlaySeason(client, now);
    const seasonId = ranked?.id ?? freePlayId;

    const account = await client.execute({
      sql: 'SELECT id, sol_balance FROM accounts WHERE user_pubkey = ? AND season_id = ?',
      args: [pubkey, seasonId],
    });
    const row = account.rows[0];
    if (!row) return EMPTY;

    const rows = await allTrades(client, Number(row['id']));
    const { closed } = reconstruct(rows.map(toLoggedTrade));
    const metrics = computeMetrics(closed);

    const commits = await commitHistory(client, seasonId, pubkey);
    const committed = commits.reduce((sum, commit) => sum + commit.leafCount, 0);

    // Return on the starting balance, which is what a season is ranked on —
    // not the profit-and-loss figure, which is a different question.
    const season = await client.execute({
      sql: 'SELECT starting_balance FROM seasons WHERE id = ?',
      args: [seasonId],
    });
    const starting = BigInt(String(season.rows[0]?.['starting_balance'] ?? '0'));

    return {
      returnBps:
        metrics.trips === 0
          ? null
          : returnBps(starting, starting + metrics.netPnl),
      trips: metrics.trips,
      committed,
      rank: null,
      entrants: 0,
    };
  } catch {
    // A card that fails to build should be a plain one, not a broken link
    // preview.
    return EMPTY;
  }
}
