import { describe, expect, it } from 'vitest';
import { capabilities, overall } from '../src/status';

function levelOf(down: Parameters<typeof capabilities>[0], capability: string) {
  return capabilities(down).find((state) => state.capability === capability)?.level;
}

describe('everything up', () => {
  it('reports every capability ok', () => {
    const states = capabilities([]);
    expect(states.every((state) => state.level === 'ok')).toBe(true);
    expect(overall(states)).toBe('ok');
  });
});

describe('the chain cannot be read', () => {
  it('stops trading rather than degrading it', () => {
    // The one thing that must never degrade. A fill quoted from a cached pool
    // is a fabricated fill, and a simulator that fabricates fills has no
    // reason to exist.
    expect(levelOf(['rpc'], 'trading')).toBe('unavailable');
  });

  it('stops season entry too', () => {
    // Both produce a record that cannot be taken back.
    expect(levelOf(['rpc'], 'entering')).toBe('unavailable');
  });

  it('lets charts degrade rather than disappear', () => {
    expect(levelOf(['rpc'], 'charts')).toBe('degraded');
  });

  it('lets the leaderboard degrade, valuing positions at cost', () => {
    expect(levelOf(['rpc'], 'leaderboard')).toBe('degraded');
  });

  it('says what a degraded capability means', () => {
    const state = capabilities(['rpc']).find((s) => s.capability === 'leaderboard');
    expect(state?.note).toContain('cost');
  });

  it('leaves signing in alone', () => {
    expect(levelOf(['rpc'], 'signIn')).toBe('ok');
  });
});

describe('the feed dropped', () => {
  it('degrades launches only', () => {
    expect(levelOf(['feed'], 'launches')).toBe('degraded');
    expect(levelOf(['feed'], 'trading')).toBe('ok');
    expect(overall(capabilities(['feed']))).toBe('degraded');
  });
});

describe('the coach is unreachable', () => {
  it('affects nothing else', () => {
    expect(levelOf(['coach'], 'coach')).toBe('degraded');
    expect(levelOf(['coach'], 'trading')).toBe('ok');
  });
});

describe('the database is down', () => {
  it('makes everything that needs it unavailable, never degraded', () => {
    // A capability that "degraded" without the database would be serving
    // something it did not read.
    expect(levelOf(['database'], 'trading')).toBe('unavailable');
    expect(levelOf(['database'], 'signIn')).toBe('unavailable');
    expect(overall(capabilities(['database']))).toBe('unavailable');
  });
});

describe('several things down at once', () => {
  it('takes the worst level overall', () => {
    expect(overall(capabilities(['feed']))).toBe('degraded');
    expect(overall(capabilities(['feed', 'rpc']))).toBe('unavailable');
  });
});
