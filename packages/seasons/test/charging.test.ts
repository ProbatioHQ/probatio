import { describe, expect, it } from 'vitest';
import { PAYOUT_PATH, chargeRefusal, explainChargeRefusal } from '../src/charging';

/**
 * The rule that stops a season taking money it cannot give back.
 *
 * It existed as a sentence in the launch sequence — never charge for entry and
 * then discover a refund cannot be paid — and a paid season was opened anyway,
 * because nothing consulted the sentence. These are what consult it now.
 */

const TREASURY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

describe('charging for entry', () => {
  it('never refuses a free season', () => {
    // Nothing was taken, so there is nothing to give back. Free play is the
    // product and must not be gated on a payout path it does not use.
    expect(chargeRefusal({ entryCost: 0n, treasury: null })).toBeNull();
    expect(chargeRefusal({ entryCost: 0n, treasury: TREASURY })).toBeNull();
  });

  it('refuses a paid season while nothing can pay a winner', () => {
    const refusal = chargeRefusal({ entryCost: 50_000_000n, treasury: TREASURY });
    expect(refusal).toBe(PAYOUT_PATH.wired ? null : 'cannot_pay_out');
  });

  it('refuses a paid season with nowhere to send the money', () => {
    // Only reachable once the payout path is wired; asserted through the same
    // switch so it cannot rot into a branch nobody runs.
    const refusal = chargeRefusal({ entryCost: 50_000_000n, treasury: null });
    expect(refusal).not.toBeNull();
  });

  it('explains every refusal it can return', () => {
    for (const refusal of ['no_treasury', 'cannot_pay_out'] as const) {
      const explanation = explainChargeRefusal(refusal);
      expect(explanation.length).toBeGreaterThan(0);
      // Said to somebody about their own money. It has to name what happens to
      // them, not report an internal state.
      expect(explanation).not.toMatch(/undefined|null|error/i);
    }
  });

  it('lists what is missing whenever it says the path is not wired', () => {
    // A bare false invites somebody to flip it. The list is the checklist they
    // have to empty first, and an empty list with wired false is a lie.
    if (!PAYOUT_PATH.wired) expect(PAYOUT_PATH.missing.length).toBeGreaterThan(0);
  });

  it('treats a negative cost as free rather than as a charge', () => {
    expect(chargeRefusal({ entryCost: -1n, treasury: null })).toBeNull();
  });
});
