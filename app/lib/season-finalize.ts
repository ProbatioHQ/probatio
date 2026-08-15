import 'server-only';
import { EMPTY_ACCUMULATOR, fromHex, toHex } from '@probatio/commit';
import { rulesetFor } from '@probatio/seasons';
import { buildFinalization, verifyFinalization } from '@probatio/scoring';
import { commitHistory, recordFinalization, seasonTotals } from '@probatio/db';
import type { AuthorityGateway } from '@probatio/vault';
import { seasonBoard } from './leaderboard';
import { db } from './db';

/**
 * Finalize a season: publish its result on chain, then record it.
 *
 * The standings are marked to the market one last time, ranked, and split by the
 * ruleset into a payout per place. That produces a results root — the 32 bytes a
 * winner's claim is proven against. The root goes on chain through
 * `finalize_season` first; only then is the database told the season is
 * finalized, because it must never claim a season paid something the program
 * does not hold. Every entrant's result and proof is frozen so a winner can
 * later claim without the numbers being recomputed under them.
 *
 * The pot is the entry fees in the vault, so the payouts sum to no more than the
 * vault holds. It self-checks with `verifyFinalization` before spending a
 * transaction on a root it could not stand behind.
 */

type Client = Awaited<ReturnType<typeof db>>;

async function accumulatorFor(client: Client, seasonId: number, trader: string): Promise<string> {
  const commits = await commitHistory(client, seasonId, trader);
  const last = commits[commits.length - 1];
  return last ? last.predictedAccumulator : toHex(EMPTY_ACCUMULATOR);
}

export async function finalizeSeasonOnChain(
  gateway: AuthorityGateway,
  client: Client,
  season: { readonly id: number; readonly ordinal: number; readonly rulesetHash: string },
  now: number,
): Promise<void> {
  const board = await seasonBoard(client, season.id, now);
  const totals = await seasonTotals(client, season.id);
  const ruleset = rulesetFor(season.ordinal);

  const entrants = await Promise.all(
    board.standings.map(async (standing) => ({
      standing: {
        trader: standing.trader,
        enteredAt: standing.enteredAt,
        startingBalance: standing.startingBalance,
        finalEquity: standing.finalEquity,
        tradeCount: standing.tradeCount,
      },
      accumulator: await accumulatorFor(client, season.id, standing.trader),
    })),
  );

  const finalization = buildFinalization({
    seasonOrdinal: season.ordinal,
    rulesetHash: season.rulesetHash,
    ruleset,
    // The vault holds the entry fees; that is what there is to pay out.
    potLamports: totals.entriesLamports,
    houseBaseLamports: totals.entriesLamports,
    entrants,
  });

  const check = verifyFinalization(finalization, ruleset);
  if (!check.ok) {
    throw new Error(`finalization for season ${season.ordinal} does not verify: ${check.reason}`);
  }

  // On chain first. If this fails, nothing is written and the next tick tries
  // again; the database is never ahead of the program.
  await gateway.finalizeSeason(season.ordinal, fromHex(finalization.resultsRoot));

  await recordFinalization(client, {
    seasonId: season.id,
    resultsRoot: finalization.resultsRoot,
    now,
    rows: finalization.rows.map((row) => ({
      trader: row.trader,
      rank: row.rank,
      startingBalance: row.startingBalance,
      finalEquity: row.finalEquity,
      returnBps: row.returnBps,
      tradeCount: row.tradeCount,
      payoutLamports: row.payoutLamports,
      proof: row.proof.map((step) => ({
        sibling: toHex(step.sibling),
        siblingOnLeft: step.siblingOnLeft,
      })),
    })),
  });
}
