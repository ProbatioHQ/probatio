import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { buildSignInMessage, type Challenge } from '../src/message';
import { AuthError, verifySignIn } from '../src/verify';

const NOW = 1_700_000_000_000;

function keypair() {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, address: bs58.encode(publicKey) };
}

function challengeFor(address: string, overrides: Partial<Challenge> = {}): Challenge {
  return {
    pubkey: address,
    nonce: 'test-nonce-value',
    domain: 'probatiotrade.com',
    uri: 'https://probatiotrade.com',
    issuedAt: NOW,
    expiresAt: NOW + 5 * 60 * 1000,
    ...overrides,
  };
}

function signChallenge(secretKey: Uint8Array, challenge: Challenge): string {
  const message = new TextEncoder().encode(buildSignInMessage(challenge));
  return bs58.encode(ed25519.sign(message, secretKey));
}

describe('buildSignInMessage', () => {
  it('is deterministic', () => {
    const { address } = keypair();
    const challenge = challengeFor(address);
    expect(buildSignInMessage(challenge)).toBe(buildSignInMessage(challenge));
  });

  it('binds the wallet, the nonce and the expiry into the signed text', () => {
    const { address } = keypair();
    const message = buildSignInMessage(challengeFor(address));
    expect(message).toContain(address);
    expect(message).toContain('test-nonce-value');
    expect(message).toContain('Expiration Time:');
  });

  it('tells the user plainly that funds cannot move', () => {
    const { address } = keypair();
    const message = buildSignInMessage(challengeFor(address));
    expect(message).toContain('cannot move your funds');
  });
});

describe('verifySignIn', () => {
  it('accepts a genuine signature', () => {
    const { secretKey, address } = keypair();
    const challenge = challengeFor(address);
    const signature = signChallenge(secretKey, challenge);

    expect(() =>
      verifySignIn({ challenge, signature, claimedPubkey: address, now: NOW }),
    ).not.toThrow();
  });

  it('rejects an expired challenge', () => {
    const { secretKey, address } = keypair();
    const challenge = challengeFor(address);
    const signature = signChallenge(secretKey, challenge);

    expect(() =>
      verifySignIn({
        challenge,
        signature,
        claimedPubkey: address,
        now: challenge.expiresAt,
      }),
    ).toThrow(expect.objectContaining({ code: 'challenge_expired' }));
  });

  it('rejects a challenge redeemed by a different wallet', () => {
    const alice = keypair();
    const mallory = keypair();
    const challenge = challengeFor(alice.address);
    const signature = signChallenge(alice.secretKey, challenge);

    expect(() =>
      verifySignIn({
        challenge,
        signature,
        claimedPubkey: mallory.address,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: 'pubkey_mismatch' }));
  });

  it('rejects a signature from the wrong key', () => {
    const alice = keypair();
    const mallory = keypair();
    const challenge = challengeFor(alice.address);
    const signature = signChallenge(mallory.secretKey, challenge);

    expect(() =>
      verifySignIn({ challenge, signature, claimedPubkey: alice.address, now: NOW }),
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }));
  });

  it('rejects a signature made over a different nonce', () => {
    const { secretKey, address } = keypair();
    const signed = challengeFor(address, { nonce: 'the-nonce-actually-signed' });
    const presented = challengeFor(address, { nonce: 'a-nonce-never-signed' });
    const signature = signChallenge(secretKey, signed);

    expect(() =>
      verifySignIn({
        challenge: presented,
        signature,
        claimedPubkey: address,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }));
  });

  it('rejects a signature made for a different domain', () => {
    const { secretKey, address } = keypair();
    const signed = challengeFor(address, { domain: 'evil.example' });
    const presented = challengeFor(address, { domain: 'probatiotrade.com' });
    const signature = signChallenge(secretKey, signed);

    expect(() =>
      verifySignIn({
        challenge: presented,
        signature,
        claimedPubkey: address,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: 'bad_signature' }));
  });

  it('rejects a malformed public key', () => {
    const { secretKey, address } = keypair();
    const challenge = challengeFor('not-a-real-key');
    const signature = signChallenge(secretKey, challengeFor(address));

    expect(() =>
      verifySignIn({
        challenge,
        signature,
        claimedPubkey: 'not-a-real-key',
        now: NOW,
      }),
    ).toThrow(AuthError);
  });

  it('rejects a signature of the wrong length', () => {
    const { address } = keypair();
    const challenge = challengeFor(address);

    expect(() =>
      verifySignIn({
        challenge,
        signature: bs58.encode(new Uint8Array(32)),
        claimedPubkey: address,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: 'malformed_signature' }));
  });

  it('rejects a signature that is not base58', () => {
    const { address } = keypair();
    const challenge = challengeFor(address);

    expect(() =>
      verifySignIn({ challenge, signature: '!!!not base58!!!', claimedPubkey: address, now: NOW }),
    ).toThrow(expect.objectContaining({ code: 'malformed_signature' }));
  });
});
