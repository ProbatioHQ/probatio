import 'server-only';
import {
  currentRankedSeason,
  ensureAccount,
  ensureFreePlaySeason,
  hasEntered,
  type AccountRow,
} from '@probatio/db';
import { tradingOpen } from '@probatio/seasons';
import type { Client } from '@libsql/client';

/**
 * Which season a trader's actions count toward.
 *
 * One answer, used by every route that touches an account. Deciding this per
 * route is how a trade ends up recorded against free play while the same
 * trader's stats are read from their ranked season — two truthful answers to
 * the same question, which is worse than one wrong one.
 *
 * A trader is in the ranked season only if they paid to enter it and it is
 * still running. Everyone else, always, is in free play: that is the product,
 * and it works with nobody else on the platform.
 */

export interface ActiveSeason {
  readonly account: AccountRow;
  readonly seasonId: number;
  readonly ranked: boolean;
  /** Set when they are entered in a ranked season, running or not. */
  readonly rankedSeasonId: number | null;
}

export async function activeSeason(
  client: Client,
  pubkey: string,
  now: number,
): Promise<ActiveSeason> {
  const ranked = await currentRankedSeason(client, now);

  if (ranked && ranked.startsAt !== null && ranked.endsAt !== null) {
    const entered = await hasEntered(client, ranked.id, pubkey);
    const open = tradingOpen(
      {
        startsAt: ranked.startsAt,
        endsAt: ranked.endsAt,
        entryClosesAt: ranked.entryClosesAt ?? ranked.endsAt,
        finalizedAt: ranked.status === 'finalized' ? ranked.endsAt : null,
      },
      now,
    );

    if (entered && open) {
      return {
        account: await ensureAccount(client, ranked.id, pubkey, now),
        seasonId: ranked.id,
        ranked: true,
        rankedSeasonId: ranked.id,
      };
    }

    if (entered) {
      // Entered, but the season is over. They fall back to free play for new
      // trades while their ranked record stays exactly as they left it.
      const freePlayId = await ensureFreePlaySeason(client, now);
      return {
        account: await ensureAccount(client, freePlayId, pubkey, now),
        seasonId: freePlayId,
        ranked: false,
        rankedSeasonId: ranked.id,
      };
    }
  }

  const freePlayId = await ensureFreePlaySeason(client, now);
  return {
    account: await ensureAccount(client, freePlayId, pubkey, now),
    seasonId: freePlayId,
    ranked: false,
    rankedSeasonId: null,
  };
}
