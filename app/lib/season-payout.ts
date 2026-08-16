import 'server-only';
import { RpcClient } from '@probatio/pools';
import { distribute, rulesetFor } from '@probatio/seasons';
import {
  currentRankedSeason,
  entryPayoutSignature,
  markSeasonFinalized,
  recordPayout,
  seasonTotals,
} from '@probatio/db';
import { db } from './db';
import { rpcEndpoint } from './env';
import { seasonBoard } from './leaderboard';
import { prizeWallet, sendPayout } from './prize';

/**
 * Pays the winners when a season ends.
 *
 * The pot is the entry fees that were paid into the prize wallet. When the
 * season is over, the final standings are ranked, split by the ruleset into a
 * payout per place, and each winner is sent their share straight out of the
 * prize wallet. The trader does nothing: they are paid, not asked to claim.
 *
 * Runs only when a prize wallet is configured, and only as one instance, so the
 * app must stay at a single replica. Each winner is paid at most once: a trader
 * who already has a payout signature is skipped, so a crash mid-payout is
 * recovered by the next tick rather than paying twice.
 */

const CYCLE_MS = 60_000;
let started = false;

export function startSeasonPayout(): void {
  if (started) return;

  const wallet = prizeWallet();
  if (!wallet) {
    console.log('[payout] no prize key configured: paid seasons will not pay out');
    return;
  }

  started = true;
  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 30_000, minIntervalMs: 100 });
  console.log(`[payout] paying winners from ${wallet.publicKey}`);

  const tick = async (): Promise<void> => {
    const client = await db();
    const now = Date.now();

    const season = await currentRankedSeason(client, now);
    if (!season || !season.ranked || season.ordinal < 0) return;
    // Not over yet, or already paid out.
    if (season.endsAt === null || now < season.endsAt) return;
    if (season.status === 'finalized') return;

    const board = await seasonBoard(client, season.id, now);
    const totals = await seasonTotals(client, season.id);
    const ruleset = rulesetFor(season.ordinal);
    const split = distribute(ruleset, totals.potLamports, board.standings.length, {
      houseBaseLamports: totals.entriesLamports,
    });

    const winnerByPlace = new Map(board.standings.map((standing) => [standing.rank, standing.trader]));

    for (const payout of split.payouts) {
      if (payout.lamports <= 0n) continue;
      const winner = winnerByPlace.get(payout.place);
      if (!winner) continue;

      // Already paid on an earlier tick: skip rather than pay twice.
      if (await entryPayoutSignature(client, { seasonId: season.id, trader: winner })) continue;

      try {
        const signature = await sendPayout(rpc, wallet, winner, payout.lamports);
        await recordPayout(client, {
          seasonId: season.id,
          trader: winner,
          payout: payout.lamports,
          txSignature: signature,
          now,
        });
        console.log(`[payout] paid place ${payout.place} (${winner}) ${payout.lamports} lamports`);
      } catch (error) {
        // Leave the season unfinalized so the next tick retries the rest.
        console.error(`[payout] paying ${winner} for season ${season.ordinal} failed`, error);
        return;
      }
    }

    await markSeasonFinalized(client, { seasonId: season.id, now });
    console.log(`[payout] season ${season.ordinal} paid out and finalized`);
  };

  void tick();
  const timer = setInterval(() => void tick(), CYCLE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
