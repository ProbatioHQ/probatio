import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  LayoutError,
  discriminatorMatches,
  readBool,
  readPubkey,
  readU8,
  readU16,
  readU64,
} from '../src/layout';
import { findProgramAddress, pubkeySeed, utf8Seed } from '../src/pda';
import { decodeMintDecimals, decodeTokenAccount } from '../src/token';

describe('readU64', () => {
  it('reads little-endian', () => {
    expect(readU64(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), 0)).toBe(1n);
    expect(readU64(Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0), 0)).toBe(256n);
  });

  it('reads u64 max without losing precision', () => {
    const data = new Uint8Array(8).fill(0xff);
    expect(readU64(data, 0)).toBe(18_446_744_073_709_551_615n);
  });

  it('holds values a double could not', () => {
    // 2^53 + 1 — the first integer a double cannot represent.
    const data = Uint8Array.of(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00);
    expect(readU64(data, 0)).toBe(9_007_199_254_740_993n);
  });

  it('refuses to read past the end', () => {
    expect(() => readU64(new Uint8Array(4), 0)).toThrow(LayoutError);
    expect(() => readU64(new Uint8Array(8), 1)).toThrow(LayoutError);
  });

  it('refuses a negative offset', () => {
    expect(() => readU64(new Uint8Array(8), -1)).toThrow(LayoutError);
  });
});

describe('readU16 and readU8', () => {
  it('read little-endian', () => {
    expect(readU16(Uint8Array.of(0x34, 0x12), 0)).toBe(0x1234);
    expect(readU8(Uint8Array.of(0xab), 0)).toBe(0xab);
  });
});

describe('readBool', () => {
  it('accepts only 0 and 1', () => {
    expect(readBool(Uint8Array.of(0), 0)).toBe(false);
    expect(readBool(Uint8Array.of(1), 0)).toBe(true);
  });

  it('refuses to coerce anything else', () => {
    // A byte that is not 0 or 1 means the offset is wrong. Returning `true`
    // here would hide a broken layout behind a confident answer.
    expect(() => readBool(Uint8Array.of(2), 0)).toThrow(/layout/);
    expect(() => readBool(Uint8Array.of(255), 0)).toThrow(/layout/);
  });
});

describe('readPubkey', () => {
  it('round-trips base58', () => {
    const key = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
    expect(readPubkey(bs58.decode(key), 0)).toBe(key);
  });

  it('refuses a short buffer', () => {
    expect(() => readPubkey(new Uint8Array(31), 0)).toThrow(LayoutError);
  });
});

describe('discriminatorMatches', () => {
  const disc = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);

  it('matches an identical prefix', () => {
    expect(discriminatorMatches(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 99), disc)).toBe(true);
  });

  it('rejects a single differing byte', () => {
    expect(discriminatorMatches(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 9), disc)).toBe(false);
  });
});

describe('findProgramAddress', () => {
  const program = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

  it('is deterministic', () => {
    const seeds = [utf8Seed('bonding-curve'), pubkeySeed(program)];
    expect(findProgramAddress(seeds, program)).toEqual(findProgramAddress(seeds, program));
  });

  it('returns a bump in range', () => {
    const { bump } = findProgramAddress([utf8Seed('bonding-curve')], program);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);
  });

  it('produces a valid 32-byte address', () => {
    const { address } = findProgramAddress([utf8Seed('seed')], program);
    expect(bs58.decode(address)).toHaveLength(32);
  });

  it('rejects an oversized seed', () => {
    expect(() => findProgramAddress([new Uint8Array(33)], program)).toThrow(/32 bytes/);
  });

  it('rejects too many seeds', () => {
    const seeds = Array.from({ length: 17 }, () => new Uint8Array(1));
    expect(() => findProgramAddress(seeds, program)).toThrow(/16 seeds/);
  });
});

describe('decodeTokenAccount', () => {
  function buildTokenAccount(amount: bigint, state = 1): Uint8Array {
    const data = new Uint8Array(165);
    data.set(bs58.decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 0);
    data.set(bs58.decode('7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr'), 32);
    let remaining = amount;
    for (let i = 0; i < 8; i += 1) {
      data[64 + i] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    data[108] = state;
    return data;
  }

  it('reads mint, owner and amount', () => {
    const account = decodeTokenAccount(buildTokenAccount(1_234_567n));
    expect(account.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(account.owner).toBe('7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr');
    expect(account.amount).toBe(1_234_567n);
    expect(account.state).toBe('initialized');
  });

  it('accepts a longer account, since Token-2022 appends extensions', () => {
    const base = buildTokenAccount(1n);
    const extended = new Uint8Array(300);
    extended.set(base, 0);
    expect(decodeTokenAccount(extended).amount).toBe(1n);
  });

  it('rejects a short account', () => {
    expect(() => decodeTokenAccount(new Uint8Array(164))).toThrow(LayoutError);
  });

  it('rejects an unknown state', () => {
    expect(() => decodeTokenAccount(buildTokenAccount(1n, 9))).toThrow(/state/);
  });
});

describe('decodeMintDecimals', () => {
  it('reads decimals', () => {
    const data = new Uint8Array(82);
    data[44] = 6;
    expect(decodeMintDecimals(data)).toBe(6);
  });

  it('rejects an implausible value', () => {
    const data = new Uint8Array(82);
    data[44] = 40;
    expect(() => decodeMintDecimals(data)).toThrow(/implausible/);
  });

  it('rejects a short account', () => {
    expect(() => decodeMintDecimals(new Uint8Array(81))).toThrow(LayoutError);
  });
});

describe('discriminatorMatches on short input', () => {
  const disc = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);

  it('returns false rather than throwing', () => {
    // Found against mainnet: a three-byte `Program data:` line threw here and
    // took down the whole log scan. "Not this" is the ordinary answer.
    expect(discriminatorMatches(Uint8Array.of(1, 2, 3), disc)).toBe(false);
    expect(discriminatorMatches(new Uint8Array(0), disc)).toBe(false);
  });
});
