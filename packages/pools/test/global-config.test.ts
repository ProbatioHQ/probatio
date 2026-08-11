import { describe, expect, it } from 'vitest';
import {
  GLOBAL_CONFIG_MIN_BYTES,
  PUMPSWAP_GLOBAL_CONFIG,
  decodePumpSwapGlobalConfig,
} from '../src/pumpswap';
import { LayoutError } from '../src/layout';

/**
 * PumpSwap's fee schedule, decoded from the live account.
 *
 * The bytes below were taken off mainnet on 11 August 2026 — the prefix the
 * decoder reads, from `${PUMPSWAP_GLOBAL_CONFIG}`. They are here so the layout
 * is pinned: an offset that drifts fails in this file rather than in a quote.
 */

const LIVE =
  'lQicyqD8sNnTu4yrNBzgUoRX8sOBfTJ4RBlj3NVf7Vi6JMmZ3awCqhQAAAAAAAAABQAAAAAAAAAASsL40N1cvJfjKJwZfLUGKlTz2Va5zm5RFfllZ6pcs+ZgjMwd/OlhtDt3nBkVBabi079F1aTbRhitdsgtYXVFNWODcwAOoiyyZNNK/2SgS176v7t03c0EiZexmBVH19EQg4R0KS5nWpS0NuywqZiJQjKKg93GIzgClhJnxc1hF8uNGBoMhJ+pN6bzSt7TCB75VwCqywybs9kJpLkUdSek69eqj7Bg2CkbTE1HXa/3Yslr3A2s6zbAEurRLtOpSEFh4ATIfOuY+lzkf4A4Bv0seUXSlSSVmuwA3tl4FPOPeEb/g4OBi6j6KMPNO21ek/n6uPCXm8NyFazFskaHe6jDyQUAAAAAAAAA';

function bytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(LIVE, 'base64'));
}

describe('the fee schedule PumpSwap publishes', () => {
  const config = decodePumpSwapGlobalConfig(bytes());

  it('reads the three rates that make up a swap', () => {
    // Cross-checked against real swaps: measure-pumpswap-fees.mts recovers
    // 29 bps of cost from the chain by arithmetic that never touches this
    // account, and these sum to 30.
    expect(config.lpFeeBps).toBe(20);
    expect(config.protocolFeeBps).toBe(5);
    expect(config.coinCreatorFeeBps).toBe(5);
  });

  it('totals a quarter of what the engine used to charge', () => {
    const total = config.lpFeeBps + config.protocolFeeBps + config.coinCreatorFeeBps;
    expect(total).toBe(30);
  });

  it('reads the admin, so a wrong offset cannot pass as a plausible fee', () => {
    expect(config.admin).toHaveLength(44);
  });

  it('refuses an account that is not the config', () => {
    const wrong = bytes();
    wrong[0] = 0x00;
    expect(() => decodePumpSwapGlobalConfig(wrong)).toThrow(LayoutError);
  });

  it('refuses an account too short to hold the fields', () => {
    expect(() => decodePumpSwapGlobalConfig(bytes().subarray(0, GLOBAL_CONFIG_MIN_BYTES - 1))).toThrow(
      LayoutError,
    );
  });

  it('refuses a fee that is not a fee', () => {
    // The failure mode of a moved offset is an enormous number, not a wrong
    // small one, so this is the check that a layout change is noticed rather
    // than quoted to somebody.
    const moved = bytes();
    new DataView(moved.buffer, moved.byteOffset, moved.byteLength).setBigUint64(0x28, 50_000n, true);
    expect(() => decodePumpSwapGlobalConfig(moved)).toThrow(/not a fee/);
  });
});
