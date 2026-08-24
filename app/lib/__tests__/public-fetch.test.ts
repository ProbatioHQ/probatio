import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../public-fetch';

/**
 * Refusing to fetch our own network on somebody else's behalf.
 *
 * A token's picture address is written by whoever launched the token, and
 * launching one is free. The card proxy turned that into a request made *by the
 * server*, which is the whole of the difference: a browser rendering the same
 * URL reaches the trader's network, and a server reaches ours.
 *
 * The ranges below are not a style choice. 169.254.169.254 is where every major
 * cloud serves instance credentials, and the v4-mapped v6 forms are how a check
 * that only knew about dotted quads gets walked straight past.
 */

describe('addresses that must never be fetched', () => {
  it('refuses loopback', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.9.9.9')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
  });

  it('refuses the cloud metadata address', () => {
    // The one that turns an image proxy into credential theft.
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('169.254.0.1')).toBe(true);
  });

  it('refuses every private v4 range', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.254')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });

  it('refuses private v6, including the v4 addresses wearing a v6 hat', () => {
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    // The bypass a dotted-quad-only check waves through.
    expect(isPrivateAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('refuses anything that is not an address at all', () => {
    // Refusing rather than guessing: an unparseable host is not evidence of
    // safety.
    expect(isPrivateAddress('not-an-address')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    // The check has to actually let real gateways through, or the feature is
    // simply broken in a way that looks like a security decision.
    expect(isPrivateAddress('104.18.0.1')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('2606:4700::1')).toBe(false);
  });
});
