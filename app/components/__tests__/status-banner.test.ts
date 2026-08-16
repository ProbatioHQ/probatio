import { describe, expect, it } from 'vitest';
import { isHealth } from '../status-banner';

describe('isHealth', () => {
  it('accepts our own health shape', () => {
    expect(isHealth({ status: 'ok', capabilities: [] })).toBe(true);
    expect(isHealth({ status: 'unavailable', capabilities: [{ level: 'unavailable', note: 'x' }] })).toBe(true);
  });

  it('rejects a proxy error body that has a status but no capabilities', () => {
    // Exactly what a 502 during a deploy returned; reading .length on the
    // missing capabilities crashed the banner on every page.
    expect(isHealth({ status: 'error', message: 'Application failed to respond' })).toBe(false);
  });

  it('rejects nulls, non-objects, and malformed capabilities', () => {
    expect(isHealth(null)).toBe(false);
    expect(isHealth('degraded')).toBe(false);
    expect(isHealth({ status: 'ok' })).toBe(false);
    expect(isHealth({ status: 'ok', capabilities: 'nope' })).toBe(false);
  });
});
