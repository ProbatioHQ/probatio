import 'server-only';
import {
  currentRankedSeason,
  ensureAccount,
  ensureFreePlaySeason,
  upsertUser,
  hasEntered,
  type AccountRow,
} from '@probatio/db';
import { tradingOpen } from '@probatio/seasons';
import type { Client } from '@libsql/client';
import { noteActivity } from './activity';

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

/**
 * The free-play season id, resolved once per process.
 *
 * Free play is created on first use and never changes id for the life of the
 * process, but `ensureFreePlaySeason` is a write every time it is called — it
 * takes the writer lock even to find the row already there. On the trade hot
 * path that put an un-queued write on every single trade, racing the trade's
 * own transaction for the lock. Resolved once and remembered, the common trade
 * stops writing here at all. A restart re-resolves it, which is when the id
 * could ever legitimately differ.
 */
let freePlaySeasonId: number | undefined;

async function freePlayId(client: Client, now: number): Promise<number> {
  freePlaySeasonId ??= await ensureFreePlaySeason(client, now);
  return freePlaySeasonId;
}

/**
 * Forget the remembered id, so the next call resolves it again.
 *
 * The cache is only correct while the database it was read from is the one
 * still being written to. That is not guaranteed for the life of a process: a
 * database found corrupt is set aside and rebuilt, and a tight volume is
 * reclaimed by swapping in a compacted copy. Either leaves this holding the id
 * of a season row that no longer exists, and `ensureAccount` refuses to build
 * an account against a season it cannot find. Every authenticated request then
 * fails, for as long as the process lives, while reads and ordinary writes both
 * keep working, which is exactly as confusing to diagnose as it sounds.
 */
function forgetFreePlay(): void {
  freePlaySeasonId = undefined;
}

export async function activeSeason(
  client: Client,
  pubkey: string,
  now: number,
): Promise<ActiveSeason> {
  try {
    return await resolveSeason(client, pubkey, now);
  } catch (error) {
    // Once, with a cleared cache. If the remembered free-play id had gone
    // stale this resolves it and the request proceeds; if the failure was
    // anything else the second attempt raises it the same way the first did.
    forgetFreePlay();
    console.error('[season] resolve failed, retrying with a fresh season id', error);
    return resolveSeason(client, pubkey, now);
  }
}

async function resolveSeason(
  client: Client,
  pubkey: string,
  now: number,
): Promise<ActiveSeason> {
  /*
   * The wallet's own row, before anything is hung off it.
   *
   * An account carries a foreign key to `users`, so building one for a wallet
   * that has no row there fails on the constraint, and every authenticated
   * request fails with it: the balance, the positions, the trade log, the
   * stats, the coach. All of them at once, while reading the session and
   * writing anything else both keep working, because a session is verified
   * from its own signature and only reads.
   *
   * That gap is reachable. A session outlives the row it was issued against if
   * the database is ever rebuilt underneath it, and the cookie stays valid for
   * as long as it was minted for, so the browser goes on believing it is signed
   * in against a database that has never heard of it.
   *
   * Written here rather than only at sign-in, because this is the point every
   * authenticated path passes through. Idempotent, and does nothing at all once
   * the row is there.
   */
  await upsertUser(client, pubkey, now);

  // Every authenticated action resolves a season, which makes this the one
  // place a wallet's presence is reliably known. Best-effort and awaited
  // deliberately: it is a single upsert at most once a day per wallet.
  await noteActivity(client, pubkey, false, now);

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
      const freeId = await freePlayId(client, now);
      return {
        account: await ensureAccount(client, freeId, pubkey, now),
        seasonId: freeId,
        ranked: false,
        rankedSeasonId: ranked.id,
      };
    }
  }

  const freeId = await freePlayId(client, now);
  return {
    account: await ensureAccount(client, freeId, pubkey, now),
    seasonId: freeId,
    ranked: false,
    rankedSeasonId: null,
  };
}
