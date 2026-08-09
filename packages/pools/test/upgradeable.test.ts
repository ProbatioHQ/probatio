import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { LayoutError } from '../src/layout';
import { decodeProgramData } from '../src/upgradeable';

const AUTHORITY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function programData(options: {
  variant?: number;
  slot?: bigint;
  authority?: string | null;
  bytecode?: number[];
}): Uint8Array {
  const authority = options.authority === undefined ? AUTHORITY : options.authority;
  const bytecode = options.bytecode ?? [1, 2, 3];
  const size = 13 + (authority ? 32 : 0) + bytecode.length;
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);

  view.setUint32(0, options.variant ?? 3, true);
  view.setBigUint64(4, options.slot ?? 100n, true);
  data[12] = authority ? 1 : 0;
  if (authority) data.set(bs58.decode(authority), 13);
  data.set(bytecode, 13 + (authority ? 32 : 0));

  return data;
}

describe('reading who can replace a program', () => {
  it('reports an authority that is still set', () => {
    const decoded = decodeProgramData(programData({}));
    expect(decoded.upgradeAuthority).toBe(AUTHORITY);
    expect(decoded.lastDeploySlot).toBe(100n);
  });

  it('reports a burned authority as none', () => {
    // The distinction the whole claim rests on: zero means the program can
    // never be replaced, one means somebody can still replace it.
    const decoded = decodeProgramData(programData({ authority: null }));
    expect(decoded.upgradeAuthority).toBeNull();
  });

  it('returns the bytecode either way, for hashing against a local build', () => {
    // A burned authority proves nothing on its own. It fixes the program
    // forever without saying which program was fixed.
    expect([...decodeProgramData(programData({})).bytecode]).toEqual([1, 2, 3]);
    expect([...decodeProgramData(programData({ authority: null })).bytecode]).toEqual([1, 2, 3]);
  });

  it('records when the bytecode was last written', () => {
    expect(decodeProgramData(programData({ slot: 987_654_321n })).lastDeploySlot).toBe(987_654_321n);
  });
});

describe('accounts it should refuse', () => {
  it('refuses a program account rather than reading past it', () => {
    // Variant 2 is the Program account, which points at this one. Decoding it
    // as ProgramData would report an authority read out of a pubkey.
    expect(() => decodeProgramData(programData({ variant: 2 }))).toThrow(LayoutError);
  });

  it('refuses a buffer', () => {
    expect(() => decodeProgramData(programData({ variant: 1 }))).toThrow(LayoutError);
  });

  it('refuses an account too short to hold a header', () => {
    expect(() => decodeProgramData(new Uint8Array(8))).toThrow(LayoutError);
  });

  it('refuses one that claims an authority it does not have room for', () => {
    const truncated = programData({}).subarray(0, 30);
    expect(() => decodeProgramData(truncated)).toThrow(LayoutError);
  });
});
