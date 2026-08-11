import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, assess, explainFlag, explainRefusal } from '../src/assess';
import type { WalletEvidence } from '../src/evidence';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const FUNDER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function evidence(overrides: Partial<WalletEvidence> = {}): WalletEvidence {
  return {
    pubkey: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    firstSeenAt: NOW - 90 * DAY,
    signatureCount: 400,
    truncated: false,
    funder: FUNDER,
    funderIsShared: false,
    gatheredAt: NOW,
    ...overrides,
  };
}

function check(overrides: Partial<WalletEvidence> = {}, siblingEntries = 0) {
  return assess({ evidence: evidence(overrides), siblingEntries, now: NOW });
}

describe('an ordinary wallet', () => {
  it('gets in with nothing recorded against it', () => {
    const result = check();
    expect(result.allowed).toBe(true);
    expect(result.flags).toEqual([]);
  });
});

describe('what is only recorded, never blocked', () => {
  it('lets a young wallet in and writes it down', () => {
    // Plenty of real traders open a fresh wallet. Refusing would cost a real
    // entrant to inconvenience someone who can age wallets in advance.
    const result = check({ firstSeenAt: NOW - DAY });
    expect(result.allowed).toBe(true);
    expect(result.flags).toContain('young_wallet');
  });

  it('lets a quiet wallet in and writes it down', () => {
    const result = check({ signatureCount: 2 });
    expect(result.allowed).toBe(true);
    expect(result.flags).toContain('quiet_wallet');
  });

  it('treats a wallet with no history at all as both', () => {
    const result = check({ firstSeenAt: null, signatureCount: 0, funder: null });
    expect(result.allowed).toBe(true);
    expect(result.flags).toEqual(['young_wallet', 'quiet_wallet']);
  });

  it('does not count an untimestamped old wallet against anybody', () => {
    // Transactions but no blockTime means old enough that the cluster stopped
    // stamping. That is the opposite of suspicious.
    const result = check({ firstSeenAt: null, signatureCount: 900 });
    expect(result.flags).toContain('unknown_age');
    expect(result.flags).not.toContain('young_wallet');
  });

  it('does not call a busy wallet quiet just because the search stopped', () => {
    // Truncated means the wallet is older and busier than it looks.
    const result = check({ signatureCount: 5, truncated: true });
    expect(result.flags).not.toContain('quiet_wallet');
  });

  it('never calls the busiest wallets on the chain new', () => {
    // Caught against real mainnet wallets. A high-volume trader burns through
    // five thousand signatures in hours, so the oldest one found is recent and
    // reads as an age. Five of six real payers were flagged young — they were
    // the most established wallets in the block.
    const result = check({ firstSeenAt: NOW - 3_600_000, signatureCount: 5_000, truncated: true });
    expect(result.flags).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it('still refuses a truncated wallet past the funder limit', () => {
    // Being busy is not a way around the one rule that refuses.
    const result = check({ truncated: true, signatureCount: 5_000 }, 3);
    expect(result.allowed).toBe(false);
  });

  it('notes a shared funder before the limit is reached', () => {
    const result = check({}, 1);
    expect(result.allowed).toBe(true);
    expect(result.flags).toContain('shared_funder');
  });
});

describe('the one refusal', () => {
  it('refuses past the funder limit', () => {
    const result = check({}, DEFAULT_RULES.maxEntriesPerFunder);
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe('funder_limit');
  });

  it('allows right up to the limit', () => {
    expect(check({}, DEFAULT_RULES.maxEntriesPerFunder - 1).allowed).toBe(true);
  });

  it('records the funder on a refusal too', () => {
    // A refused attempt is evidence, and the evidence is the product here.
    const result = check({}, 5);
    expect(result.funder).toBe(FUNDER);
    expect(result.flags).toContain('shared_funder');
  });

  it('cannot refuse a wallet whose funder is unknown', () => {
    // An unreadable funder is unknown, never assumed. Refusing on an
    // assumption would take somebody's entry away on a guess.
    const result = check({ funder: null }, 99);
    expect(result.allowed).toBe(true);
    expect(result.refusal).toBeNull();
  });
});

describe('a funder that is shared plumbing rather than a person', () => {
  // Somebody buying SOL for the first time and withdrawing it to a fresh wallet
  // has an exchange as the fee payer of their first transaction — checked
  // against mainnet, not assumed. Counting that as one person meant the first
  // three exchange withdrawals took the whole season's quota and everybody
  // after them was refused for a limit a stranger had reached.
  it('never refuses on an exchange, however many share it', () => {
    const result = check({ funderIsShared: true }, 5_000);
    expect(result.allowed).toBe(true);
    expect(result.refusal).toBeNull();
  });

  it('does not hold it against them either', () => {
    // A flag that fires on nearly every real entrant is noise, and this one is
    // kept forever as evidence about them. Using an exchange is not evidence.
    const result = check({ funderIsShared: true }, 5_000);
    expect(result.flags).not.toContain('shared_funder');
  });

  it('still records which exchange it was', () => {
    // Not counted is not the same as not known. Dropping the funder would lose
    // the fact that the wallet came off an exchange at all.
    expect(check({ funderIsShared: true }, 5_000).funder).toBe(FUNDER);
  });

  it('leaves the age and history flags alone', () => {
    // The refusal is the only thing a shared funder changes. A brand new wallet
    // is still recorded as brand new.
    const result = check({
      funderIsShared: true,
      firstSeenAt: NOW - DAY,
      signatureCount: 2,
    }, 5_000);
    expect(result.flags).toContain('young_wallet');
    expect(result.flags).toContain('quiet_wallet');
    expect(result.allowed).toBe(true);
  });

  it('still refuses a farmer, whose funding wallet is not shared', () => {
    // The rule has to keep working on what it was aimed at.
    const result = check({ funderIsShared: false }, DEFAULT_RULES.maxEntriesPerFunder);
    expect(result.allowed).toBe(false);
    expect(result.refusal).toBe('funder_limit');
  });

  it('does not flag a shared funder when there is no funder', () => {
    expect(check({ funder: null }, 3).flags).not.toContain('shared_funder');
  });
});

describe('the rules are the rules', () => {
  it('gives the same answer for the same input', () => {
    // No discretion anywhere. A rule applied by judgement after a result is
    // not a rule.
    const first = check({ firstSeenAt: NOW - DAY }, 1);
    const second = check({ firstSeenAt: NOW - DAY }, 1);
    expect(second).toEqual(first);
  });

  it('honours a season with different thresholds', () => {
    const strict = assess({
      evidence: evidence(),
      siblingEntries: 1,
      now: NOW,
      rules: { ...DEFAULT_RULES, maxEntriesPerFunder: 1 },
    });
    expect(strict.allowed).toBe(false);
  });

  it('explains a refusal in terms of the published limit', () => {
    expect(explainRefusal('funder_limit')).toContain(String(DEFAULT_RULES.maxEntriesPerFunder));
  });

  it('has a sentence for every flag', () => {
    for (const flag of ['young_wallet', 'quiet_wallet', 'unknown_age', 'shared_funder'] as const) {
      expect(explainFlag(flag).length).toBeGreaterThan(10);
    }
  });
});
