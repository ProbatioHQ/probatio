import { describe, expect, it } from 'vitest';
import {
  POOL_DISCRIMINATOR,
  POOL_OFFSETS,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  decodePumpSwapPool,
} from '../src/pumpswap';
import { LayoutError } from '../src/layout';
import { decodeTokenAccount } from '../src/token';
import {
  BASE_VAULT_BASE64,
  PUMPSWAP_POOL,
  QUOTE_VAULT_BASE64,
  bytes,
} from './fixtures/pumpswap';

describe('decodePumpSwapPool', () => {
  const pool = decodePumpSwapPool(bytes(PUMPSWAP_POOL.base64));

  it('reads the mint the pool actually quotes', () => {
    expect(pool.baseMint).toBe(PUMPSWAP_POOL.mint);
  });

  it('quotes against wrapped SOL', () => {
    expect(pool.quoteMint).toBe(WSOL_MINT);
  });

  it('is owned by the PumpSwap program', () => {
    expect(PUMPSWAP_POOL.owner).toBe(PUMPSWAP_PROGRAM_ID);
  });

  it('reads the remaining fields', () => {
    expect(pool.poolBump).toBeGreaterThanOrEqual(0);
    expect(pool.poolBump).toBeLessThanOrEqual(255);
    expect(pool.index).toBeGreaterThanOrEqual(0);
    expect(pool.lpSupply).toBeGreaterThan(0n);
    for (const key of ['creator', 'lpMint', 'baseVault', 'quoteVault', 'coinCreator'] as const) {
      expect(pool[key]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });
});

describe('the pool and its vaults agree', () => {
  const pool = decodePumpSwapPool(bytes(PUMPSWAP_POOL.base64));
  const base = decodeTokenAccount(bytes(BASE_VAULT_BASE64));
  const quote = decodeTokenAccount(bytes(QUOTE_VAULT_BASE64));

  it('the base vault holds the base mint', () => {
    // The decisive check on the layout. If baseVault were read from the wrong
    // offset it would point at an unrelated account, and the reserves used to
    // price every trade would be someone else's balance.
    expect(base.mint).toBe(pool.baseMint);
  });

  it('the quote vault holds wrapped SOL', () => {
    expect(quote.mint).toBe(WSOL_MINT);
  });

  it('both vaults are owned by the pool', () => {
    expect(base.owner).toBe(PUMPSWAP_POOL.address);
    expect(quote.owner).toBe(PUMPSWAP_POOL.address);
  });

  it('both vaults hold a real balance', () => {
    expect(base.amount).toBeGreaterThan(0n);
    expect(quote.amount).toBeGreaterThan(0n);
  });
});

describe('decodePumpSwapPool rejects bad input', () => {
  it('rejects a truncated account', () => {
    expect(() => decodePumpSwapPool(bytes(PUMPSWAP_POOL.base64).subarray(0, 100))).toThrow(
      LayoutError,
    );
  });

  it('rejects a different account type', () => {
    const data = bytes(PUMPSWAP_POOL.base64).slice();
    data[0] = (data[0]! + 1) % 256;
    expect(() => decodePumpSwapPool(data)).toThrow(/discriminator/);
  });

  it('rejects a pool with the same mint on both sides', () => {
    const data = bytes(PUMPSWAP_POOL.base64).slice();
    data.copyWithin(POOL_OFFSETS.quoteMint, POOL_OFFSETS.baseMint, POOL_OFFSETS.baseMint + 32);
    expect(() => decodePumpSwapPool(data)).toThrow(/same mint/);
  });

  it('rejects a pool with one vault on both sides', () => {
    const data = bytes(PUMPSWAP_POOL.base64).slice();
    data.copyWithin(POOL_OFFSETS.quoteVault, POOL_OFFSETS.baseVault, POOL_OFFSETS.baseVault + 32);
    expect(() => decodePumpSwapPool(data)).toThrow(/one vault/);
  });
});

describe('discriminator', () => {
  it('matches the captured pool', () => {
    expect(bytes(PUMPSWAP_POOL.base64).subarray(0, 8)).toEqual(POOL_DISCRIMINATOR);
  });
});
