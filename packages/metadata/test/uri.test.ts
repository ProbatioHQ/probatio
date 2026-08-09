import { describe, expect, it } from 'vitest';
import { UnsafeUriError, isFetchableUri, resolveMetadataUri } from '../src/uri';

/**
 * The metadata URI is written on chain by whoever launched the token, and the
 * server fetches it. That is a request originating inside our network against
 * an address an attacker chose — so these tests are the security boundary, not
 * input validation.
 */

describe('accepts ordinary public https', () => {
  it.each([
    'https://ipfs.io/ipfs/bafkreiabc',
    'https://arweave.net/abc123',
    'https://example.com/metadata.json',
    'https://cdn.example.co.uk/a/b/c.json',
  ])('%s', (uri) => {
    expect(() => resolveMetadataUri(uri)).not.toThrow();
  });
});

describe('rewrites ipfs:// to a gateway', () => {
  it('handles the bare form', () => {
    expect(resolveMetadataUri('ipfs://bafkreiabc')).toBe('https://ipfs.io/ipfs/bafkreiabc');
  });

  it('handles the ipfs://ipfs/ form', () => {
    expect(resolveMetadataUri('ipfs://ipfs/bafkreiabc')).toBe('https://ipfs.io/ipfs/bafkreiabc');
  });
});

describe('refuses non-https schemes', () => {
  it.each([
    ['plain http', 'http://example.com/a.json'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:application/json,{}'],
    ['javascript', 'javascript:alert(1)'],
    ['ftp', 'ftp://example.com/a.json'],
    ['gopher', 'gopher://example.com/'],
  ])('%s', (_label, uri) => {
    expect(() => resolveMetadataUri(uri)).toThrow(UnsafeUriError);
  });
});

describe('refuses the loopback and link-local ranges', () => {
  it.each([
    ['localhost by name', 'https://localhost/a.json'],
    ['a localhost subdomain', 'https://foo.localhost/a.json'],
    ['IPv4 loopback', 'https://127.0.0.1/a.json'],
    ['a different loopback address', 'https://127.1.2.3/a.json'],
    ['IPv6 loopback', 'https://[::1]/a.json'],
    ['this network', 'https://0.0.0.0/a.json'],
  ])('%s', (_label, uri) => {
    expect(() => resolveMetadataUri(uri)).toThrow(UnsafeUriError);
  });
});

describe('refuses cloud instance metadata', () => {
  it.each([
    ['the well-known link-local address', 'https://169.254.169.254/latest/meta-data/'],
    ['anything else link-local', 'https://169.254.1.1/a.json'],
    ['the Google internal name', 'https://metadata.google.internal/a.json'],
  ])('%s', (_label, uri) => {
    // The single most valuable thing this check prevents: an attacker-chosen
    // URI turning into a read of the server's own cloud credentials.
    expect(() => resolveMetadataUri(uri)).toThrow(UnsafeUriError);
  });
});

describe('refuses private ranges', () => {
  it.each([
    ['10/8', 'https://10.0.0.1/a.json'],
    ['172.16/12', 'https://172.16.0.1/a.json'],
    ['172.31 upper bound', 'https://172.31.255.255/a.json'],
    ['192.168/16', 'https://192.168.1.1/a.json'],
    ['carrier-grade NAT', 'https://100.64.0.1/a.json'],
    ['multicast', 'https://239.1.1.1/a.json'],
  ])('%s', (_label, uri) => {
    expect(() => resolveMetadataUri(uri)).toThrow(UnsafeUriError);
  });

  it('does not over-block addresses that merely look similar', () => {
    // 172.15 and 172.32 sit outside the private block and are ordinary public
    // addresses. An over-broad rule here would silently break real tokens.
    expect(() => resolveMetadataUri('https://172.15.0.1/a.json')).not.toThrow();
    expect(() => resolveMetadataUri('https://172.32.0.1/a.json')).not.toThrow();
    expect(() => resolveMetadataUri('https://11.0.0.1/a.json')).not.toThrow();
  });
});

describe('refuses every IPv6 literal, public or not', () => {
  it.each([
    ['loopback', 'https://[::1]/a.json'],
    ['unique local', 'https://[fd00::1]/a.json'],
    ['link-local', 'https://[fe80::1]/a.json'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/a.json'],
    ['IPv4-mapped private', 'https://[::ffff:10.0.0.1]/a.json'],
    ['NAT64-mapped loopback', 'https://[64:ff9b::7f00:1]/a.json'],
    ['a genuinely public address', 'https://[2606:4700:4700::1111]/a.json'],
  ])('%s', (_label, uri) => {
    // Deliberately broader than "private ranges". The URL parser rewrites
    // ::ffff:127.0.0.1 into ::ffff:7f00:1 before any check runs, and NAT64
    // maps the whole IPv4 space into IPv6, so a denylist cannot be trusted.
    // No real metadata gateway uses a bare IPv6 literal.
    expect(() => resolveMetadataUri(uri)).toThrow(UnsafeUriError);
  });
});

describe('refuses other hostile shapes', () => {
  it('rejects a bare internal hostname', () => {
    expect(() => resolveMetadataUri('https://internal-admin/a.json')).toThrow(UnsafeUriError);
  });

  it('rejects embedded credentials', () => {
    expect(() => resolveMetadataUri('https://user:pass@example.com/a.json')).toThrow(
      /credentials/,
    );
  });

  it('rejects an empty or malformed uri', () => {
    expect(() => resolveMetadataUri('')).toThrow(UnsafeUriError);
    expect(() => resolveMetadataUri('   ')).toThrow(UnsafeUriError);
    expect(() => resolveMetadataUri('not a url')).toThrow(UnsafeUriError);
  });
});

describe('isFetchableUri', () => {
  it('answers without throwing', () => {
    expect(isFetchableUri('https://example.com/a.json')).toBe(true);
    expect(isFetchableUri('https://127.0.0.1/a.json')).toBe(false);
    expect(isFetchableUri('')).toBe(false);
  });
});
