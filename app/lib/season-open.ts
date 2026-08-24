import type { SeasonRow } from '@probatio/db';
import { tradingOpen } from '@probatio/seasons';

/**
 * Whether a trade placed now counts toward a season.
 *
 * The one answer, in one place, because it was being derived separately in four
 * and two of them derived it wrongly.
 *
 * WHY NOT `season.status`
 *
 * The `status` column is written by a job. `statusAt` derives the same answer
 * from the season's own timestamps, and its doc comment says why that is the
 * real one: a status cannot be left behind by a process that failed halfway
 * through if there is no process. Reading the column means trusting a job to
 * have run; reading the clock means trusting the clock.
 *
 * WHY `entry_open` COUNTS
 *
 * Because it is the first two days of every season, and people trade in it. A
 * season is open for trading from the moment it starts, and the entry window is
 * about whether somebody may still join, not whether the people already in it
 * may act. Gating on `status === 'running'` gets that exactly backwards: it
 * shuts trading for the two days when the board is being made and opens it for
 * the rest. Humans were never gated that way, which is how it survived — the
 * only thing checking for `'running'` was the machinery that runs strategies,
 * so an algorithm was refused the clock its owner was already trading on.
 */
export function seasonTradingOpen(season: SeasonRow, now: number): boolean {
  if (season.startsAt === null || season.endsAt === null) return false;
  return tradingOpen(
    {
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      // A season with no stated close never stops taking entries, which is the
      // reading that lets somebody in rather than the one that shuts them out.
      entryClosesAt: season.entryClosesAt ?? season.endsAt,
      finalizedAt: season.status === 'finalized' ? season.endsAt : null,
    },
    now,
  );
}

/**
 * Why a season is not open, in words that are true of the season in front of
 * you.
 *
 * A strategy stopped by the loop records the reason on itself, and its owner
 * reads it. "The season is no longer running" is the right sentence for exactly
 * one of the three cases and a false one for the other two — it was told to
 * people whose season had not started yet, about a season that had not ended.
 */
export function whyNotOpen(season: SeasonRow | null, now: number): string {
  if (!season) return 'there is no season to trade in';
  if (season.startsAt !== null && now < season.startsAt) return 'the season has not started yet';
  if (season.endsAt !== null && now >= season.endsAt) return 'the season has finished';
  if (season.status === 'finalized') return 'the season has been finalized';
  return 'the season is not open for trading';
}
