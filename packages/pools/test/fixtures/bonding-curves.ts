/**
 * Real BondingCurve accounts captured from mainnet.
 *
 * These are raw bytes, not hand-written values, so the offline tests exercise
 * the same input the decoder meets in production. Both states are here on
 * purpose: a live curve and a graduated one, because graduation zeroes every
 * reserve and that is the case most likely to be mistaken for corruption.
 */

export interface CurveFixture {
  readonly mint: string;
  readonly curveAddress: string;
  readonly owner: string;
  readonly base64: string;
}

export const LIVE_CURVE: CurveFixture = {
  "mint": "3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump",
  "curveAddress": "FHeBR39zwYtUuXQFLbShSsVKkEG6ti5Eup3zUdopiegi",
  "owner": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "base64": "F7f4N2DYrGCvnrZuJxACADgzAegMAAAArwakIpYRAQA4h93rBQAAAACAxqR+jQMAAIK+tgGQVwGbOuCqKt/ps/fXMgFIr61UuIOBWSD5v7YuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
};

export const GRADUATED_CURVE: CurveFixture = {
  "mint": "J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump",
  "curveAddress": "GnWf1qMe4fc5VKcTPPcBcr9seyJxVfUnV1qhJU3SCDdu",
  "owner": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "base64": "F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAAV6RLoMfFDyBhIzuSk6Aj60lBYEf96EzHeGpC/4YbicCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
};

export function fixtureBytes(fixture: CurveFixture): Uint8Array {
  return Uint8Array.from(Buffer.from(fixture.base64, 'base64'));
}
