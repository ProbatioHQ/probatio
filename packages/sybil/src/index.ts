/**
 * @probatio/sybil — making a track record expensive to fake.
 *
 * Not about the prize. Farming the pot does not pay: an attacker holding k of
 * N entries expects k/N of it whatever the payout shape, which after the house
 * cut is a guaranteed small loss. What pays is farming a *record* — run twenty
 * wallets, keep the one that got lucky three seasons running, and present it as
 * skill to whoever is deciding where capital goes.
 *
 * The nineteen discarded wallets are invisible by the time that decision is
 * made. So the evidence is gathered when they enter, and kept.
 */

export { gatherEvidence } from './evidence';
export type { WalletEvidence } from './evidence';

export { DEFAULT_RULES, assess, explainFlag, explainRefusal } from './assess';
export type { AssessInput, Assessment, Flag, Refusal, SybilRules } from './assess';
