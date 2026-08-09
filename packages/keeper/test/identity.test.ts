import { describe, expect, it } from 'vitest';
import { checkIdentity } from '../src/identity';

const KEY = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const OTHER = 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump';

describe('confirming the keeper before it signs anything', () => {
  it('accepts the key the season names', () => {
    const check = checkIdentity(KEY, { keeper: KEY, status: 'Running' });
    expect(check.ok).toBe(true);
  });

  it('refuses a key that was rotated away', () => {
    // The quiet failure this exists for: a rotated key keeps trying, fails
    // every transaction, and looks like an RPC problem while the season runs
    // out.
    const check = checkIdentity(KEY, { keeper: OTHER, status: 'Running' });
    expect(check.ok).toBe(false);
    expect(check.onChain).toBe(OTHER);
  });

  it('says to stay stopped rather than to retry', () => {
    // If the key was rotated after a compromise, finding a way to keep signing
    // is the wrong instinct.
    const check = checkIdentity(KEY, { keeper: OTHER, status: 'Running' });
    expect(check.detail).toContain('stay stopped');
  });

  it('refuses a season that does not exist', () => {
    expect(checkIdentity(KEY, null).ok).toBe(false);
  });

  it('refuses a finalized season', () => {
    const check = checkIdentity(KEY, { keeper: KEY, status: 'Finalized' });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('finalized');
  });
});
