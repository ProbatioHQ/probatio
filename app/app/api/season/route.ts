import {
  currentRankedSeason,
  ensureFreePlaySeason,
  hasEntered,
  seasonTotals,
} from '@probatio/db';
import {
  bandFor,
  distribute,
  nextBand,
  rulesetFor,
  rulesetHashHex,
  statusAt,
  timeUntilEntryCloses,
} from '@probatio/seasons';
import { DEFAULT_RULES } from '@probatio/sybil';
import { explainCondition } from '@probatio/seasons';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { currentUser } from '@/lib/session';

/**
 * The season, as anybody can see it.
 *
 * Public: the pot, the entrant count, and what each place would be paid if the
 * season closed now. That last one is the number worth showing — it is why
 * bringing somebody else matters, and it moves when they arrive.
 *
 * The ruleset hash is included so a visitor can recompute it from the published
 * rules and compare it to what the program recorded. A rule that cannot be
 * checked is a promise.
 */

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const client = await db();
  const now = Date.now();

  // Free play always exists, so the answer is never "no seasons".
  await ensureFreePlaySeason(client, now);

  const season = await currentRankedSeason(client, now);
  if (!season || season.startsAt === null || season.endsAt === null) {
    return Response.json({
      ranked: null,
      freePlay: { open: true, startingBalance: '10000000000' },
    });
  }

  const timing = {
    startsAt: season.startsAt,
    endsAt: season.endsAt,
    entryClosesAt: season.entryClosesAt ?? season.endsAt,
    finalizedAt: season.status === 'finalized' ? season.endsAt : null,
  };

  const status = statusAt(timing, now);
  const totals = await seasonTotals(client, season.id);
  const rules = rulesetFor(season.ordinal);

  // The cut applies to what entrants paid, not to a sponsored prize — taking
  // a tenth of money somebody put up as the prize would advertise more than
  // the season pays.
  const projection = distribute(rules, totals.potLamports, totals.entrants, {
    houseBaseLamports: totals.entriesLamports,
  });
  const upcoming = nextBand(rules, totals.potLamports);

  const user = await currentUser();
  const entered = user ? await hasEntered(client, season.id, user.pubkey) : false;

  return Response.json({
    ranked: {
      id: season.id,
      ordinal: season.ordinal,
      name: season.name,
      status,
      startsAt: timing.startsAt,
      endsAt: timing.endsAt,
      entryClosesAt: timing.entryClosesAt,
      entryClosesInMs: timeUntilEntryCloses(timing, now),

      entryCost: season.entryCost,
      startingBalance: season.startingBalance,
      scoring: rules.scoring,

      entrants: totals.entrants,
      potLamports: totals.potLamports.toString(),
      // Kept apart because they mean different things if the season voids:
      // entries are owed back, a sponsored prize was never the entrants'.
      entriesLamports: totals.entriesLamports.toString(),
      sponsorLamports: totals.sponsorLamports.toString(),

      // What the pot would pay right now, and what the next band would add.
      paidPlaces: projection.paidPlaces,
      payouts: projection.payouts.map((payout) => ({
        place: payout.place,
        lamports: payout.lamports.toString(),
      })),
      houseLamports: projection.house.toString(),
      currentBandPlaces: bandFor(rules, totals.potLamports).sharesBps.length,
      // No next band on a free season. The pot is put up rather than paid for
      // by entries, so more entrants do not grow it — and asking how many
      // entries away the next band is divides by an entry cost of zero.
      nextBand:
        upcoming === null || BigInt(season.entryCost) === 0n
          ? null
          : {
              atPotLamports: upcoming.minPotLamports.toString(),
              places: upcoming.sharesBps.length,
              entriesAway: Number(
                (upcoming.minPotLamports - totals.potLamports + BigInt(season.entryCost) - 1n) /
                  BigInt(season.entryCost),
              ),
            },

      // The hash recorded when the season was created, not one computed now.
      // Recomputing would let a later change to the rules quietly rewrite what
      // a running season published.
      eligibility: {
        maxEntriesPerFunder: DEFAULT_RULES.maxEntriesPerFunder,
        note:
          'One entry per wallet. Entries funded from the same source are limited, ' +
          'and every entry records what the chain said about its wallet at the time.',
      },
      // Published with the season, and hashed into its ruleset. A season can
      // only be voided before its results are on chain.
      voidPolicy: {
        ...rules.voidPolicy,
        conditions: (
          [
            'feed_outage',
            'chain_halt',
            'uncommitted_trades',
            'irreproducible_trades',
            'engine_changed',
          ] as const
        ).map((condition) => ({ condition, why: explainCondition(condition) })),
        refund: 'Every entrant is refunded exactly what they paid. No house cut.',
        finalIsFinal: 'Once results are on chain the season cannot be voided.',
      },

      rulesetHash: season.rulesetHash,
      // What today's code produces for this ordinal. Equal to the above unless
      // the rules have been edited since, in which case saying so is the point.
      rulesetHashNow: rulesetHashHex(rules),
      entered,
    },
    freePlay: { open: true, startingBalance: '10000000000' },
  });
}
