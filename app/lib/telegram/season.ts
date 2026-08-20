import 'server-only';
import { currentRankedSeason, hasEntered, seasonTotals } from '@probatio/db';
import {
  distribute,
  nextBand,
  rulesetFor,
  statusAt,
  timeUntilEntryCloses,
} from '@probatio/seasons';
import { db } from '../db';
import { seasonBoard } from '../leaderboard';

/**
 * The season, for somebody standing in a chat.
 *
 * The bot could trade all day without ever mentioning that a competition is
 * running, which is the state it was in: a trader placing fills from Telegram
 * had no idea there was a season, an entry deadline, or a pot. That is the
 * product going unmentioned by the surface most likely to be someone's only
 * contact with it.
 *
 * The figures are the same ones the season page reads, from the same functions,
 * so the two cannot disagree about the pot or the deadline.
 */

export interface SeasonNow {
  readonly name: string;
  readonly status: string;
  readonly entryCost: bigint;
  readonly startingBalance: bigint;
  readonly entrants: number;
  readonly potLamports: bigint;
  readonly paidPlaces: number;
  readonly topPrize: bigint;
  /** Milliseconds until entry closes, or null once it has. */
  readonly entryClosesInMs: number | null;
  readonly endsAt: number;
  /** How many more entries would widen the payout, when that applies. */
  readonly nextBand: { places: number; entriesAway: number } | null;
  /** Where the asker stands, when they are linked and entered. */
  readonly you: { rank: number; of: number; returnBps: number } | null;
  readonly entered: boolean;
}

export async function seasonNow(pubkey: string | null, now: number): Promise<SeasonNow | null> {
  const client = await db();
  const season = await currentRankedSeason(client, now);
  if (!season || season.startsAt === null || season.endsAt === null) return null;

  const timing = {
    startsAt: season.startsAt,
    endsAt: season.endsAt,
    entryClosesAt: season.entryClosesAt ?? season.endsAt,
    finalizedAt: season.status === 'finalized' ? season.endsAt : null,
  };

  const rules = rulesetFor(season.ordinal);
  const totals = await seasonTotals(client, season.id);
  const projection = distribute(rules, totals.potLamports, totals.entrants, {
    houseBaseLamports: totals.entriesLamports,
  });
  const upcoming = nextBand(rules, totals.potLamports);
  const entered = pubkey ? await hasEntered(client, season.id, pubkey) : false;

  /*
   * The board is only read for somebody who is actually in the season.
   *
   * It prices every open position across every entrant, which is the most
   * expensive thing on this page, and it answers a question nobody who has not
   * entered has asked.
   */
  let you: SeasonNow['you'] = null;
  if (entered && pubkey) {
    const board = await seasonBoard(client, season.id, now);
    const mine = board.standings.find((standing) => standing.trader === pubkey);
    if (mine) {
      you = { rank: mine.rank, of: board.standings.length, returnBps: mine.returnBps };
    }
  }

  // Null once entry has closed, which is a different thing from zero left.
  const remaining = timeUntilEntryCloses(timing, now);

  return {
    name: season.name,
    status: statusAt(timing, now),
    entryCost: BigInt(season.entryCost),
    startingBalance: BigInt(season.startingBalance),
    entrants: totals.entrants,
    potLamports: totals.potLamports,
    paidPlaces: projection.paidPlaces,
    topPrize: projection.payouts[0]?.lamports ?? 0n,
    entryClosesInMs: remaining !== null && remaining > 0 ? remaining : null,
    endsAt: season.endsAt,
    nextBand:
      upcoming === null || BigInt(season.entryCost) === 0n
        ? null
        : {
            places: upcoming.sharesBps.length,
            entriesAway: Number(
              (upcoming.minPotLamports - totals.potLamports + BigInt(season.entryCost) - 1n) /
                BigInt(season.entryCost),
            ),
          },
    you,
    entered,
  };
}

/**
 * A duration somebody reads rather than parses.
 *
 * Two units and no more: "2 days 11 hours" is a deadline, "2 days 11 hours 4
 * minutes 12 seconds" is a stopwatch, and nobody in a chat is counting seconds
 * against a deadline four days out.
 */
export function howLong(ms: number): string {
  if (ms <= 0) return 'closed';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);

  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours > 0) {
    const rest = minutes % 60;
    return `${hours} hour${hours === 1 ? '' : 's'} ${rest} min`;
  }
  return `${minutes} min`;
}
