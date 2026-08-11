import { describe, expect, it } from 'vitest';
import {
  POOL_DISCRIMINATOR,
  POOL_MIN_BYTES,
  POOL_WITH_OFFSET_BYTES,
  POOL_OFFSETS,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  decodePumpSwapPool,
  pumpSwapReserveOffset,
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

describe('pool accounts of different lengths', () => {
  /**
   * Pools are 300 and 301 bytes on mainnet, both common. The fields this reads
   * sit at fixed offsets from the start, so a longer account must decode
   * identically rather than being refused — refusing one would take a token off
   * the board instead of reading it.
   */
  const canonical = bytes(PUMPSWAP_POOL.base64);

  function padded(extra: number): Uint8Array {
    const grown = new Uint8Array(canonical.length + extra);
    grown.set(canonical);
    return grown;
  }

  it('decodes an account with trailing bytes it does not interpret', () => {
    const longer = decodePumpSwapPool(padded(1));
    expect(longer).toEqual(decodePumpSwapPool(canonical));
  });

  it('decodes one with a good deal more of them', () => {
    expect(decodePumpSwapPool(padded(58)).baseVault).toBe(
      decodePumpSwapPool(canonical).baseVault,
    );
  });

  it('still refuses an account too short to hold the fields', () => {
    expect(() => decodePumpSwapPool(canonical.subarray(0, POOL_MIN_BYTES - 1))).toThrow(
      LayoutError,
    );
  });
});

describe('the SOL a pool counts beyond its quote vault', () => {
  /**
   * Some pools price against more SOL than they hold. Quoting the raw vault
   * balance put the engine a constant 2.8 times away from the market on such a
   * pool; adding this took the same replay from 8,937 bps of error to 28.
   */
  function withOffset(value: bigint): Uint8Array {
    const data = new Uint8Array(POOL_WITH_OFFSET_BYTES);
    data.set(bytes(PUMPSWAP_POOL.base64).subarray(0, POOL_MIN_BYTES));
    new DataView(data.buffer).setBigUint64(POOL_OFFSETS.quoteReserveOffset, value, true);
    return data;
  }

  it('reads the offset when the account carries one', () => {
    expect(pumpSwapReserveOffset(withOffset(17_584_505_389n))).toBe(17_584_505_389n);
  });

  it('is zero on a pool that counts only its vault', () => {
    expect(pumpSwapReserveOffset(withOffset(0n))).toBe(0n);
  });

  it('is zero when the account is too short to carry one', () => {
    // Reading past the end would produce a number, and a wrong reserve is far
    // worse than no adjustment: adding nothing leaves the old behaviour, which
    // is exact on every pool that has no offset to add.
    expect(pumpSwapReserveOffset(bytes(PUMPSWAP_POOL.base64).subarray(0, POOL_MIN_BYTES))).toBe(0n);
  });
});
