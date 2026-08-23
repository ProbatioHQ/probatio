import { beforeEach, describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { PoolReader, forgetPool } from '../src/reader';
import { PUMP_PROGRAM_ID, bondingCurveAddress } from '../src/pumpfun';
import {
  POOL_DISCRIMINATOR,
  POOL_OFFSETS,
  POOL_WITH_OFFSET_BYTES,
  WSOL_MINT,
} from '../src/pumpswap';
import { TOKEN_ACCOUNT_BYTES, TOKEN_ACCOUNT_OFFSETS } from '../src/token';
import type { RpcClient } from '../src/rpc';

/**
 * Remembering which pool is a graduated mint's market.
 *
 * Finding it means scanning every account the PumpSwap program owns, because a
 * pool's address comes from its creator and cannot be derived from the mint.
 * That scan costs twenty credits against a plain read's one, and it ran twice
 * per fill, on both sides of the latency wait: about ninety-six credits for a
 * round trip, eighty of which were the same question asked four times.
 *
 * The thing that makes it safe to remember is what is *not* remembered. Reserves
 * are read fresh every time. These tests hold that line: the second read must
 * skip the scan and must still see a market that has moved.
 */

const MINT = bs58.encode(new Uint8Array(32).fill(7));
const POOL = bs58.encode(new Uint8Array(32).fill(1));
const RIVAL = bs58.encode(new Uint8Array(32).fill(2));
const BASE_VAULT = bs58.encode(new Uint8Array(32).fill(3));
const QUOTE_VAULT = bs58.encode(new Uint8Array(32).fill(4));
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function account(data: Uint8Array, owner: string, slot = 42) {
  return { data, owner, lamports: 0n, slot };
}

/** A mint account: only its decimals byte is read. */
function mintAccount() {
  const data = new Uint8Array(82);
  data[44] = 6;
  return account(data, TOKEN_PROGRAM);
}

/** A pool account carrying the two mints and the two vaults. */
function poolAccount() {
  const data = new Uint8Array(POOL_WITH_OFFSET_BYTES);
  // Without this the account decodes as some other type and is filtered out.
  data.set(POOL_DISCRIMINATOR, 0);
  data.set(bs58.decode(MINT), POOL_OFFSETS.baseMint);
  data.set(bs58.decode(WSOL_MINT), POOL_OFFSETS.quoteMint);
  data.set(bs58.decode(bs58.encode(new Uint8Array(32).fill(5))), POOL_OFFSETS.lpMint);
  data.set(bs58.decode(BASE_VAULT), POOL_OFFSETS.baseVault);
  data.set(bs58.decode(QUOTE_VAULT), POOL_OFFSETS.quoteVault);
  return account(data, RIVAL);
}

function vault(mint: string, amount: bigint, slot = 42) {
  const data = new Uint8Array(TOKEN_ACCOUNT_BYTES);
  data.set(bs58.decode(mint), TOKEN_ACCOUNT_OFFSETS.mint);
  data.set(bs58.decode(POOL), TOKEN_ACCOUNT_OFFSETS.owner);
  new DataView(data.buffer).setBigUint64(TOKEN_ACCOUNT_OFFSETS.amount, amount, true);
  data[TOKEN_ACCOUNT_OFFSETS.state] = 1;
  return account(data, TOKEN_PROGRAM, slot);
}

/**
 * A chain where the pool's depth can be changed between reads, and where every
 * program scan is counted.
 */
function chain() {
  const curveAddress = bondingCurveAddress(MINT);
  let sol = 40_000_000_000n;
  let token = 900_000_000_000_000n;
  let scans = 0;

  const rpc = {
    async getAccounts(addresses: readonly string[]) {
      return addresses.map((address) => {
        // Shrunk: this token has graduated.
        if (address === curveAddress) return account(new Uint8Array(49), PUMP_PROGRAM_ID);
        if (address === MINT) return mintAccount();
        if (address === POOL) return poolAccount();
        if (address === BASE_VAULT) return vault(MINT, token);
        if (address === QUOTE_VAULT) return vault(WSOL_MINT, sol);
        return null;
      });
    },
    async getProgramAccounts() {
      scans += 1;
      return [{ address: POOL, account: poolAccount() }];
    },
  } as unknown as RpcClient;

  return {
    reader: new PoolReader(rpc),
    scans: () => scans,
    setDepth: (nextSol: bigint, nextToken: bigint) => {
      sol = nextSol;
      token = nextToken;
    },
  };
}

beforeEach(() => {
  forgetPool(MINT);
});

describe('the remembered pool', () => {
  it('scans once and then stops scanning', async () => {
    const { reader, scans } = chain();

    const first = await reader.resolve(MINT);
    expect(first.venue).toEqual({ kind: 'pumpswap', poolAddress: POOL, graduated: true });
    expect(scans()).toBe(1);

    // The saving: four more fills' worth of reads, none of them the scan.
    for (let i = 0; i < 4; i += 1) await reader.resolve(MINT);
    expect(scans()).toBe(1);
  });

  it('reads the reserves fresh every time', async () => {
    const { reader, setDepth } = chain();

    const before = await reader.resolve(MINT);
    expect(before.pool?.solReserve).toBe(40_000_000_000n);

    // A swap lands. The pool is the same pool; its balances are not.
    setDepth(31_000_000_000n, 1_100_000_000_000_000n);

    const after = await reader.resolve(MINT);
    expect(after.pool?.solReserve).toBe(31_000_000_000n);
    expect(after.pool?.tokenReserve).toBe(1_100_000_000_000_000n);
  });

  it('searches again when the remembered pool has been emptied', async () => {
    const { reader, scans, setDepth } = chain();

    await reader.resolve(MINT);
    expect(scans()).toBe(1);

    // Drained. Quoting this would refuse every trade on a token that is
    // trading perfectly well in some other pool.
    setDepth(0n, 0n);
    await reader.resolve(MINT);

    expect(scans()).toBe(2);
  });

  it('is forgotten on demand', async () => {
    const { reader, scans } = chain();

    await reader.resolve(MINT);
    await reader.resolve(MINT);
    expect(scans()).toBe(1);

    forgetPool(MINT);
    await reader.resolve(MINT);
    expect(scans()).toBe(2);
  });
});
