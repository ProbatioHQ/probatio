import {
  activeName,
  allTrades,
  commitHistory,
  currentRankedSeason,
  ensureFreePlaySeason,
  hasEntered,
} from '@probatio/db';
import { computeMetrics, reconstruct } from '@probatio/analytics';
import { shortAddress } from '@probatio/profile';
import { db } from '@/lib/db';
import { toLoggedTrade } from '@/lib/analytics';

/**
 * A trader's public record.
 *
 * Public because a record nobody can look at is not a record, it is a claim.
 * Every number here is derived from trades that are committed on chain, and the
 * proof endpoint hands over what is needed to check them.
 *
 * The display name is decoration over the address. The address is always shown,
 * because it is the identity, and a name that could hide it would be a way to
 * borrow somebody else's reputation.
 */

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const trader = url.searchParams.get('trader');

  if (!trader || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trader)) {
    return Response.json({ error: 'trader must be a base58 address' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();

  const freePlayId = await ensureFreePlaySeason(client, now);
  const ranked = await currentRankedSeason(client, now);

  const account = await client.execute({
    sql: 'SELECT id, season_id FROM accounts WHERE user_pubkey = ? ORDER BY season_id DESC',
    args: [trader],
  });

  if (account.rows.length === 0) {
    return Response.json({
      trader,
      name: null,
      display: shortAddress(trader),
      exists: false,
      seasons: [],
    });
  }

  const seasons = await Promise.all(
    account.rows.map(async (row) => {
      const accountId = Number(row['id']);
      const seasonId = Number(row['season_id']);
      const rows = await allTrades(client, accountId);
      const { closed } = reconstruct(rows.map(toLoggedTrade));
      const metrics = computeMetrics(closed);
      const commits = await commitHistory(client, seasonId, trader);

      return {
        seasonId,
        ranked: ranked !== null && seasonId === ranked.id,
        freePlay: seasonId === freePlayId,
        trades: rows.length,
        roundTrips: metrics.trips,
        winRateBps: metrics.winRateBps,
        netPnl: metrics.netPnl.toString(),
        // What is actually on chain. A trader with trades and no commitments
        // has a record nobody can check yet, and saying so is the point.
        committedBatches: commits.length,
        committedTrades: commits.reduce((sum, commit) => sum + commit.leafCount, 0),
      };
    }),
  );

  const name = await activeName(client, trader);

  return Response.json({
    trader,
    name,
    display: name ?? shortAddress(trader),
    exists: true,
    enteredRanked: ranked ? await hasEntered(client, ranked.id, trader) : false,
    seasons,
    proof: `/api/proof?trader=${trader}`,
  });
}
