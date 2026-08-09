/**
 * A real PumpSwap pool and its two vaults, captured from mainnet.
 *
 * The vaults are here because a pool account does not carry its reserves — it
 * carries the addresses of the token accounts that do. Testing the decoder
 * without them would leave the half that actually produces a price untested.
 */

export interface PoolFixture {
  readonly address: string;
  readonly mint: string;
  readonly owner: string;
  readonly base64: string;
}

export const PUMPSWAP_POOL: PoolFixture = {
  "address": "GeaAnhd7M6GFHZVUB9FNkmV6Vf7HQTfEqi7WB6USi1f3",
  "mint": "J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump",
  "owner": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "base64": "8ZptBBGxbbz/AACXwWfwEMUtpmFUkwtYxrs9H3EWkRL33NKoqVjtIpzhnf3VIw+oxRjVFvBngAt/WcSA/NzYMCTIwMKRC1KSSswvBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEaJTAoKUa1PMWce/99jt/dfoR480jGY8ZA/N2Jq/TzUbttRL69H++O7RPfLkC+f1+gzB3lbmfKqx2vDlGOl/qLULZj1OZN/NKGXXxQ6x96RpwvoDq0kimJXQlFqRr2XR8buGtZ0AMAAF6RLoMfFDyBhIzuSk6Aj60lBYEf96EzHeGpC/4YbicCAADEQh4YBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
};

export const BASE_VAULT_BASE64 = '/dUjD6jFGNUW8GeAC39ZxID83NgwJMjAwpELUpJKzC/of0xA3dlo1PIO/8F4StAei1LjxjV/hWK9RKoER/x8thSfjV3KQwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgcAAAA=';
export const QUOTE_VAULT_BASE64 = 'BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHof0xA3dlo1PIO/8F4StAei1LjxjV/hWK9RKoER/x8traLGFgCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAADwHR8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function bytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}
