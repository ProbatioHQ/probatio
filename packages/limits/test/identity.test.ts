import { describe, expect, it } from 'vitest';
import { callerKey, clientAddress } from '../src/identity';

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('finding the caller', () => {
  it('reads the address one proxy put there', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores what the caller claimed in front of it', () => {
    // THE bug in most rate limiters. Reading the leftmost entry means an
    // attacker sets the header, gets a fresh bucket every request, and the
    // limiter enforces nothing while appearing to work.
    expect(
      clientAddress(headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })),
    ).toBe('203.0.113.7');
  });

  it('ignores a whole forged chain', () => {
    expect(
      clientAddress(headers({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.7' })),
    ).toBe('203.0.113.7');
  });

  it('counts past more proxies when told there are more', () => {
    expect(
      clientAddress(headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.0.0.1' }), {
        trustedProxies: 2,
      }),
    ).toBe('203.0.113.7');
  });

  it('does not fall off the front when there are fewer hops than proxies', () => {
    expect(
      clientAddress(headers({ 'x-forwarded-for': '203.0.113.7' }), { trustedProxies: 3 }),
    ).toBe('203.0.113.7');
  });

  it('reads an edge header that a caller cannot forge the same way', () => {
    expect(clientAddress(headers({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('prefers the forwarded chain when both are present', () => {
    expect(
      clientAddress(headers({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '1.1.1.1' })),
    ).toBe('203.0.113.7');
  });

  it('treats a mapped IPv4 as the address it is', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('strips a port', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': '203.0.113.7:51234' }))).toBe('203.0.113.7');
  });

  it('survives an empty or junk header', () => {
    expect(clientAddress(headers({ 'x-forwarded-for': '' }))).toBeNull();
    expect(clientAddress(headers({ 'x-forwarded-for': ' , , ' }))).toBeNull();
    expect(clientAddress(headers({}))).toBeNull();
  });
});

describe('the key a caller is limited on', () => {
  it('uses the wallet when there is one', () => {
    // Two traders on one office connection are two callers; one wallet moving
    // between networks is one caller.
    expect(callerKey('abc', '203.0.113.7')).toBe('w:abc');
  });

  it('falls back to the address', () => {
    expect(callerKey(null, '203.0.113.7')).toBe('a:203.0.113.7');
  });

  it('puts everybody unidentifiable in one bucket', () => {
    // Harsh on purpose: stripping your address means sharing with everyone
    // else who did.
    expect(callerKey(null, null)).toBe('unknown');
  });
});
