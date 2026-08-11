import type { WalletEvidence } from './evidence';

/**
 * Whether a wallet may enter, and what to write down either way.
 *
 * Two tiers, deliberately.
 *
 * Refusal is reserved for what is demonstrable: too many entries funded from
 * one place. That is a fact about the chain, not a judgement, and it is the
 * only signal strong enough to justify taking somebody's money off the table.
 *
 * Everything else is recorded, not blocked. A wallet made yesterday is not
 * evidence of anything — plenty of real traders open a fresh one — and refusing
 * it would cost a genuine entrant to inconvenience an attacker who can simply
 * age wallets in advance. But the flag is kept forever, so that when the
 * question is "does this person have a three-season record worth backing", the
 * answer can include "their wallet was one of nineteen made the same week".
 *
 * There is no discretion anywhere in here. The thresholds are published with
 * the season and the same input always produces the same answer, because a
 * rule applied by judgement after a result is not a rule.
 */

export interface SybilRules {
  /** Entries funded from one source, per season. Beyond this, refused. */
  readonly maxEntriesPerFunder: number;
  /** Below this age at entry, the entry is flagged. Never refused. */
  readonly youngWalletMs: number;
  /** Below this many prior transactions, flagged. */
  readonly quietWalletSignatures: number;
}

export const DEFAULT_RULES: SybilRules = {
  // Three is generous for a household and cheap for nobody running fifty.
  maxEntriesPerFunder: 3,
  youngWalletMs: 7 * 24 * 60 * 60 * 1_000,
  quietWalletSignatures: 10,
};

export type Flag = 'young_wallet' | 'quiet_wallet' | 'unknown_age' | 'shared_funder';
export type Refusal = 'funder_limit';

export interface Assessment {
  readonly allowed: boolean;
  readonly refusal: Refusal | null;
  /** Recorded with the entry whether it was allowed or not. */
  readonly flags: readonly Flag[];
  readonly funder: string | null;
}

export interface AssessInput {
  readonly evidence: WalletEvidence;
  /** Entries already in this season funded by the same source. */
  readonly siblingEntries: number;
  readonly now: number;
  readonly rules?: SybilRules;
}

export function assess(input: AssessInput): Assessment {
  const rules = input.rules ?? DEFAULT_RULES;
  const { evidence } = input;
  const flags: Flag[] = [];

  // A truncated search means the wallet has more history than we looked at, so
  // the oldest transaction found is not its first — it is merely the oldest of
  // the last few thousand. Reading that as an age gets it exactly backwards:
  // the busiest wallets on the chain, which are the most established, hit the
  // limit within hours and would every one of them read as new.
  if (evidence.truncated) {
    // Nothing to flag. Thousands of transactions is the opposite of a wallet
    // spun up to farm a season.
  } else if (evidence.firstSeenAt === null) {
    if (evidence.signatureCount === 0) {
      // A wallet with no history at all. Brand new, and worth saying so.
      flags.push('young_wallet', 'quiet_wallet');
    } else {
      // Transactions but no timestamp: old enough that the cluster stopped
      // stamping them. That is the opposite of suspicious, and it is recorded
      // as unknown rather than counted against them.
      flags.push('unknown_age');
    }
  } else if (input.now - evidence.firstSeenAt < rules.youngWalletMs) {
    flags.push('young_wallet');
  }

  if (
    !evidence.truncated &&
    evidence.signatureCount < rules.quietWalletSignatures &&
    !flags.includes('quiet_wallet')
  ) {
    flags.push('quiet_wallet');
  }

  // A funder that pays for thousands of wallets is not evidence about this one.
  // See evidence.ts: an exchange withdrawal makes the exchange the fee payer of
  // a new wallet's first transaction, so counting it refused the newcomers this
  // exists to welcome and flagged the rest for using an exchange. Neither the
  // refusal nor the flag applies to shared plumbing; the funder is still
  // recorded, because dropping it would lose the fact that it was an exchange.
  const funderIdentifies = evidence.funder !== null && !evidence.funderIsShared;

  if (funderIdentifies && input.siblingEntries > 0) {
    flags.push('shared_funder');
  }

  // The one refusal. Counting entries already funded from here, so the limit is
  // the number of entries that source may have in the season in total.
  if (funderIdentifies && input.siblingEntries >= rules.maxEntriesPerFunder) {
    return { allowed: false, refusal: 'funder_limit', flags, funder: evidence.funder };
  }

  return { allowed: true, refusal: null, flags, funder: evidence.funder };
}

export function explainRefusal(refusal: Refusal, rules: SybilRules = DEFAULT_RULES): string {
  switch (refusal) {
    case 'funder_limit':
      return (
        `This wallet was funded from a source that already has ` +
        `${rules.maxEntriesPerFunder} entries in this season. That is the limit.`
      );
  }
}

export function explainFlag(flag: Flag): string {
  switch (flag) {
    case 'young_wallet':
      return 'The wallet was created recently.';
    case 'quiet_wallet':
      return 'The wallet has little history of its own.';
    case 'unknown_age':
      return 'The wallet is older than the cluster records timestamps for.';
    case 'shared_funder':
      return 'Another entry in this season was funded from the same source.';
  }
}
