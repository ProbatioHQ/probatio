import { describe, expect, it } from 'vitest';
import {
  BONDING_CURVE_DISCRIMINATOR,
  BONDING_CURVE_OFFSETS,
  PUMPFUN_TOKEN_TOTAL_SUPPLY,
  bondingCurveAddress,
  decodeBondingCurve,
} from '../src/pumpfun';
import { LayoutError } from '../src/layout';
import { GRADUATED_CURVE, LIVE_CURVE, fixtureBytes } from './fixtures/bonding-curves';

describe('decodeBondingCurve on a live curve', () => {
  const curve = decodeBondingCurve(fixtureBytes(LIVE_CURVE));

  it('reads the fixed supply', () => {
    expect(curve.tokenTotalSupply).toBe(PUMPFUN_TOKEN_TOTAL_SUPPLY);
  });

  it('reads reserves that satisfy the venue invariants', () => {
    expect(curve.virtualSolReserves).toBeGreaterThan(0n);
    expect(curve.virtualTokenReserves).toBeGreaterThan(0n);
    expect(curve.realTokenReserves).toBeLessThanOrEqual(curve.virtualTokenReserves);
    expect(curve.realTokenReserves).toBeLessThanOrEqual(curve.tokenTotalSupply);
  });

  it('is not complete', () => {
    expect(curve.complete).toBe(false);
  });

  it('reads a creator', () => {
    expect(curve.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

describe('decodeBondingCurve on a graduated curve', () => {
  const curve = decodeBondingCurve(fixtureBytes(GRADUATED_CURVE));

  it('decodes rather than failing', () => {
    // The case most likely to be mistaken for corruption: graduation drains
    // every reserve to zero, and a decoder that rejects that makes every
    // graduated token unreadable.
    expect(curve.complete).toBe(true);
    expect(curve.virtualSolReserves).toBe(0n);
    expect(curve.virtualTokenReserves).toBe(0n);
    expect(curve.realSolReserves).toBe(0n);
    expect(curve.realTokenReserves).toBe(0n);
  });

  it('still reports the supply and creator', () => {
    expect(curve.tokenTotalSupply).toBe(PUMPFUN_TOKEN_TOTAL_SUPPLY);
    expect(curve.creator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

describe('decodeBondingCurve rejects bad input', () => {
  it('rejects a truncated account', () => {
    expect(() => decodeBondingCurve(fixtureBytes(LIVE_CURVE).subarray(0, 40))).toThrow(LayoutError);
  });

  it('rejects an account with a different discriminator', () => {
    const data = fixtureBytes(LIVE_CURVE).slice();
    data[0] = (data[0]! + 1) % 256;
    expect(() => decodeBondingCurve(data)).toThrow(/discriminator/);
  });

  it('rejects a live curve whose reserves decode to zero', () => {
    // Simulates an offset drifting: the discriminator still matches but the
    // numbers are nonsense.
    const data = fixtureBytes(LIVE_CURVE).slice();
    data.fill(0, BONDING_CURVE_OFFSETS.virtualTokenReserves, BONDING_CURVE_OFFSETS.tokenTotalSupply);
    expect(() => decodeBondingCurve(data)).toThrow(/zero virtual reserve/);
  });

  it('rejects a byte that cannot be a bool', () => {
    const data = fixtureBytes(LIVE_CURVE).slice();
    data[BONDING_CURVE_OFFSETS.complete] = 7;
    expect(() => decodeBondingCurve(data)).toThrow(/bool/);
  });

  it('rejects real reserves above the total supply', () => {
    const data = fixtureBytes(LIVE_CURVE).slice();
    // Set real_token_reserves to u64 max.
    data.fill(0xff, BONDING_CURVE_OFFSETS.realTokenReserves, BONDING_CURVE_OFFSETS.realTokenReserves + 8);
    expect(() => decodeBondingCurve(data)).toThrow(/layout is probably wrong/);
  });
});

describe('bondingCurveAddress', () => {
  it('derives the address the account actually lives at', () => {
    // Both fixtures were fetched from the derived address, so a match here
    // confirms the PDA implementation against real chain state.
    expect(bondingCurveAddress(LIVE_CURVE.mint)).toBe(LIVE_CURVE.curveAddress);
    expect(bondingCurveAddress(GRADUATED_CURVE.mint)).toBe(GRADUATED_CURVE.curveAddress);
  });

  it('is deterministic', () => {
    expect(bondingCurveAddress(LIVE_CURVE.mint)).toBe(bondingCurveAddress(LIVE_CURVE.mint));
  });

  it('gives different mints different curves', () => {
    expect(bondingCurveAddress(LIVE_CURVE.mint)).not.toBe(bondingCurveAddress(GRADUATED_CURVE.mint));
  });
});

describe('discriminator', () => {
  it('matches both captured accounts', () => {
    for (const fixture of [LIVE_CURVE, GRADUATED_CURVE]) {
      expect(fixtureBytes(fixture).subarray(0, 8)).toEqual(BONDING_CURVE_DISCRIMINATOR);
    }
  });
});
