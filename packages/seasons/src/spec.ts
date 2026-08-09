import type { Ruleset } from './ruleset';

/**
 * The locked ruleset.
 *
 * These numbers are the published ones. Changing any of them changes the
 * ruleset hash, which is what makes a change visible rather than quiet —
 * a season already running keeps the rules it was created with.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Season 1 is a week. Later seasons run a fortnight. */
export const SEASON_ONE_DURATION_MS = 7 * DAY_MS;
export const SEASON_DURATION_MS = 14 * DAY_MS;
/** Entries close 48 hours in. Later arrivals play free and enter the next one. */
export const ENTRY_WINDOW_MS = 2 * DAY_MS;

export const STARTING_BALANCE = 10n * LAMPORTS_PER_SOL;
export const ENTRY_COST = LAMPORTS_PER_SOL / 20n;

export const HOUSE_BPS = 1_000;
/**
 * No cut below one SOL.
 *
 * Under this the pot is worth less than a hundred dollars and taking a tenth
 * of it looks worse than the tenth is worth. It also keeps the smallest case
 * clean: a single entrant wins back exactly what they paid.
 */
export const HOUSE_THRESHOLD = LAMPORTS_PER_SOL;

/**
 * Payout shape by pot size.
 *
 * Widening as the pot grows is what makes the entry count worth showing people
 * — at twenty entrants third place starts paying, at a hundred it reaches
 * tenth. That is a reason to bring somebody rather than a number on a page.
 */
export const PAYOUT_BANDS = [
  // Under 1 SOL, roughly under twenty entrants: winner takes all.
  { minPotLamports: 0n, sharesBps: [10_000] },
  // 1 to 5 SOL.
  { minPotLamports: LAMPORTS_PER_SOL, sharesBps: [5_500, 3_000, 1_500] },
  // Over 5 SOL, roughly a hundred entrants and up.
  {
    minPotLamports: 5n * LAMPORTS_PER_SOL,
    sharesBps: [3_000, 1_800, 1_200, 1_000, 500, 500, 500, 500, 500, 500],
  },
] as const;

/** The simulation conditions, matching the engine's own defaults. */
export const LATENCY_MS = 600;
export const SLIPPAGE_BPS = 1_000;
export const MAX_PRICE_IMPACT_BPS = 5_000;
export const ENGINE_VERSION = 1;

export function rulesetFor(ordinal: number): Ruleset {
  return {
    ordinal,
    durationMs: ordinal <= 1 ? SEASON_ONE_DURATION_MS : SEASON_DURATION_MS,
    entryWindowMs: ENTRY_WINDOW_MS,
    startingBalance: STARTING_BALANCE,
    entryCost: ENTRY_COST,
    houseBps: HOUSE_BPS,
    houseThreshold: HOUSE_THRESHOLD,
    latencyMs: LATENCY_MS,
    slippageBps: SLIPPAGE_BPS,
    maxPriceImpactBps: MAX_PRICE_IMPACT_BPS,
    engineVersion: ENGINE_VERSION,
    scoring: 'highest_return',
    bands: PAYOUT_BANDS.map((band) => ({
      minPotLamports: band.minPotLamports,
      sharesBps: [...band.sharesBps],
    })),
  };
}
