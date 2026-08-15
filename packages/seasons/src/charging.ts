/**
 * Whether a season may charge for entry.
 *
 * The program pays a prize exactly one way: `claim_prize` moves lamports out of
 * the season vault, against the results root `finalize_season` published, to a
 * trader who holds an on-chain `Entry`. `refund_entry` pays a void season back
 * from the same vault against the same account. Both of them, and nothing else,
 * are how money leaves.
 *
 * The whole path now exists and money reaches every part of it. `/api/pay/intent`
 * builds a `record_entry` the trader signs, funding the vault and creating the
 * `Entry`; the lifecycle worker creates and finalizes the season through the
 * authority; finalization freezes the results root and each winner's proof; and
 * `/api/claim` builds the `claim_prize` or `refund_entry` the winner signs. It
 * was proven end to end against the program on a cluster before this was flipped
 * — a season created, entered, finalized, and its prize claimed from the vault —
 * so a paid season taken today can be paid out or refunded.
 *
 * The rule the project learned once — never charge for entry and then discover a
 * refund cannot be paid — is kept by having the code that takes the money consult
 * this. It stayed refused until the refund could actually be paid.
 *
 * Going live is still gated by the operator: without an authority key configured
 * against a deployed program, no season is created on chain, so entry stays
 * closed regardless of this flag. Free play is untouched either way.
 */

/** What has to exist before an entry fee can be honoured. Empty: the path is wired. */
export const PAYOUT_PATH = {
  /**
   * Flip to true only when every item below is false — that is, when a trader
   * who wins can actually be paid, proven end to end rather than assumed.
   */
  wired: true,
  missing: [],
} as const;

export type ChargeRefusal = 'cannot_pay_out';

export interface ChargeInput {
  readonly entryCost: bigint;
}

/**
 * Why this season may not charge, or null when it may.
 *
 * A free season is always allowed: there is nothing to give back. Entry money
 * goes to the season's vault through `record_entry`, not to a treasury, so no
 * treasury needs to be configured for a paid season to open — only the payout
 * path has to be proven end to end, which is what `PAYOUT_PATH.wired` gates.
 */
export function chargeRefusal(input: ChargeInput): ChargeRefusal | null {
  if (input.entryCost <= 0n) return null;
  if (!PAYOUT_PATH.wired) return 'cannot_pay_out';
  return null;
}

/** Said to the person who would have paid, in the terms that matter to them. */
export function explainChargeRefusal(refusal: ChargeRefusal): string {
  switch (refusal) {
    case 'cannot_pay_out':
      return 'Entry is free for now. A paid season is not open because the payout path is not yet verified end to end, and taking an entry fee before it can be returned is not something this will do. Free play is open, and trades made in it are committed exactly the same way.';
  }
}
