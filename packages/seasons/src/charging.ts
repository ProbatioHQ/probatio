/**
 * Whether a season may charge for entry.
 *
 * The program pays a prize exactly one way: `claim_prize` moves lamports out of
 * the season vault, against the results root `finalize_season` published, to a
 * trader who holds an on-chain `Entry`. `refund_entry` pays a void season back
 * from the same vault against the same account. Both of them, and nothing else,
 * are how money leaves.
 *
 * The app takes entry money a different way. `/api/pay/intent` builds a plain
 * system transfer to a treasury wallet and `/api/pay/confirm` credits the entry
 * in the database once it lands. That path never calls `record_entry`, so no
 * `Entry` account exists and the vault is never funded. Money taken this way
 * cannot be paid out and cannot be refunded — not by a key that was lost, but
 * by any key at all, because there is no instruction that can reach it.
 *
 * Nothing off chain closes the gap either. `resultsRoot` in @probatio/scoring
 * computes the 32 bytes `finalize_season` records and is called by its own test
 * and nowhere else; no gateway method finalizes a season; no route serves a
 * trader the proof a claim needs; and no code anywhere sets a season's status
 * to `finalized`. The standings are recomputed live on every request and never
 * frozen.
 *
 * So a season that ends today pays nobody, and this is where that stops being
 * an abstract gap: it is somebody's 0.05 SOL.
 *
 * The project already learned this once. Season 0 ran free because the void
 * policy promised refunds the program could not pay, and the launch sequence
 * has carried the rule since: never charge for entry and then discover a refund
 * cannot be paid. That rule lived in a document, which is why it was possible
 * to open a paid season without noticing it had been broken. It lives here now,
 * where the code that takes the money has to consult it.
 *
 * This refuses the charge, not the season. Free play is untouched, trades are
 * committed exactly as before, and a sponsored prize is the operator's own
 * money to leave in a vault if they choose. What may not happen is taking an
 * entrant's SOL for a prize nothing can award.
 */

/** What has to exist before an entry fee can be honoured, and what does not. */
export const PAYOUT_PATH = {
  /**
   * Flip to true only when every item below is false — that is, when a trader
   * who wins can actually be paid, proven end to end rather than assumed.
   */
  wired: false,
  missing: [
    'the finalization job is not wired: nothing calls finalize_season at a season end or records its root',
    'the claim route is not built: a winner has no way to obtain their proof and submit claim_prize',
    'the whole path has not been proven end to end on a cluster',
  ],
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
