/**
 * Buying practice balance.
 *
 * Free play starts everybody at ten SOL of play money. Some people want to
 * practise with an account the size of the one they actually trade, and that is
 * a reasonable thing to want and a reasonable thing to sell.
 *
 * It is sold for free play and nowhere else, and that restriction is the whole
 * design rather than a caveat on it. Ranking is by percentage return, so buying
 * more looks harmless — until you notice when somebody would buy. A trader down
 * fifty percent, five SOL left of ten, buys a hundred: their starting balance
 * becomes a hundred and ten, their equity a hundred and five, and a season that
 * was minus fifty percent is now minus four. The loss is gone. Nobody who is up
 * would ever buy, because it dilutes their gain the same way.
 *
 * That turns a season into a spending contest with extra steps, which is the
 * exact opposite of the thing being sold. So a ranked season keeps the fixed
 * starting balance hashed into its published ruleset, and purchased balance
 * cannot reach it — not by a rule somebody remembers to apply, but because the
 * credit is written to the free-play account and a season's is a different row.
 *
 * Prices fall per SOL as the size goes up, the ordinary way a larger purchase
 * works. They are deliberately small: this is a practice account, not a stake,
 * and pricing it like a stake would suggest it buys something it does not.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export interface PracticeTier {
  /** Whole SOL of practice balance credited. */
  readonly sol: number;
  /** What it costs, in lamports. */
  readonly priceLamports: bigint;
}

export const PRACTICE_TIERS: readonly PracticeTier[] = Object.freeze([
  { sol: 1, priceLamports: 10_000_000n },
  { sol: 3, priceLamports: 25_000_000n },
  { sol: 10, priceLamports: 60_000_000n },
  { sol: 25, priceLamports: 120_000_000n },
  { sol: 50, priceLamports: 200_000_000n },
  { sol: 100, priceLamports: 350_000_000n },
]);

/** The tier for a size, or null if that size is not sold. */
export function tierFor(sol: number): PracticeTier | null {
  return PRACTICE_TIERS.find((tier) => tier.sol === sol) ?? null;
}

/** What a tier credits, in lamports. */
export function creditFor(tier: PracticeTier): bigint {
  return BigInt(tier.sol) * LAMPORTS_PER_SOL;
}

/**
 * Cost per SOL, in lamports. Only for showing somebody the discount they are
 * getting; nothing is priced from it.
 */
export function pricePerSol(tier: PracticeTier): bigint {
  return tier.priceLamports / BigInt(tier.sol);
}
