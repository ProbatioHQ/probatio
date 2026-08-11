import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { PoolReader } from '../src/reader';
import { TOKEN_ACCOUNT_BYTES, TOKEN_ACCOUNT_OFFSETS } from '../src/token';
import { WSOL_MINT } from '../src/pumpswap';
import type { PumpSwapPool } from '../src/pumpswap';
import type { RpcClient } from '../src/rpc';

/**
 * Choosing which pool is the market.
 *
 * Anyone can open a PumpSwap pool for any mint. Picking the wrong one does not
 * show up as a wrong price — arbitrage keeps spot prices together — it shows up
 * as a wrong fill, because depth is what sets price impact. It is also the
 * cheapest way to attack a leaderboard: quote a trader from a pool they own and
 * they set the price of their own trades.
 */

function pubkey(seed: number): string {
  const bytes = new Uint8Array(32).fill(seed);
  return bs58.encode(bytes);
}

/** A minimal SPL token account, so a vault's depth can be stated exactly. */
function vault(mint: string, owner: string, amount: bigint): { data: Uint8Array; slot: number } {
  const data = new Uint8Array(TOKEN_ACCOUNT_BYTES);
  data.set(bs58.decode(mint), TOKEN_ACCOUNT_OFFSETS.mint);
  data.set(bs58.decode(owner), TOKEN_ACCOUNT_OFFSETS.owner);
  new DataView(data.buffer).setBigUint64(TOKEN_ACCOUNT_OFFSETS.amount, amount, true);
  data[TOKEN_ACCOUNT_OFFSETS.state] = 1; // initialized
  return { data, slot: 1 };
}

function candidate(address: string, quoteVault: string): { address: string; pool: PumpSwapPool } {
  return {
    address,
    pool: {
      baseMint: pubkey(9),
      quoteMint: WSOL_MINT,
      baseVault: pubkey(8),
      quoteVault,
    } as PumpSwapPool,
  };
}

/** Serves the vault accounts a selection asks for, and counts the calls. */
function readerOver(vaults: Record<string, { data: Uint8Array; slot: number } | null>) {
  let calls = 0;
  const rpc = {
    async getAccounts(addresses: readonly string[]) {
      calls += 1;
      return addresses.map((address) => vaults[address] ?? null);
    },
  } as unknown as RpcClient;
  return { reader: new PoolReader(rpc), calls: () => calls };
}

const POOL_A = pubkey(1);
const POOL_B = pubkey(2);
const POOL_C = pubkey(3);
const VAULT_A = pubkey(11);
const VAULT_B = pubkey(12);
const VAULT_C = pubkey(13);

describe('picking the pool that is actually the market', () => {
  it('takes the deepest, not the first the RPC listed', async () => {
    // The shape measured on mainnet: the first pool returned held 0.0044 SOL
    // while the real market held 46.1 SOL.
    const { reader } = readerOver({
      [VAULT_A]: vault(WSOL_MINT, POOL_A, 4_383_000n),
      [VAULT_B]: vault(WSOL_MINT, POOL_B, 46_145_060_000n),
    });

    const chosen = await reader.deepestPool([
      candidate(POOL_A, VAULT_A),
      candidate(POOL_B, VAULT_B),
    ]);
    expect(chosen?.address).toBe(POOL_B);
  });

  it('is unmoved by the order the pools arrive in', async () => {
    const vaults = {
      [VAULT_A]: vault(WSOL_MINT, POOL_A, 1_000n),
      [VAULT_B]: vault(WSOL_MINT, POOL_B, 9_000_000n),
      [VAULT_C]: vault(WSOL_MINT, POOL_C, 5_000n),
    };
    const pools = [
      candidate(POOL_A, VAULT_A),
      candidate(POOL_B, VAULT_B),
      candidate(POOL_C, VAULT_C),
    ];

    const first = await readerOver(vaults).reader.deepestPool(pools);
    const reversed = await readerOver(vaults).reader.deepestPool([...pools].reverse());
    expect(first?.address).toBe(POOL_B);
    expect(reversed?.address).toBe(POOL_B);
  });

  it('breaks a tie the same way every time', async () => {
    // Two servers, or one server replaying a season, must choose identically or
    // the fills are not reproducible.
    const vaults = {
      [VAULT_A]: vault(WSOL_MINT, POOL_A, 7_000n),
      [VAULT_B]: vault(WSOL_MINT, POOL_B, 7_000n),
    };
    const pools = [candidate(POOL_A, VAULT_A), candidate(POOL_B, VAULT_B)];

    const forwards = await readerOver(vaults).reader.deepestPool(pools);
    const backwards = await readerOver(vaults).reader.deepestPool([...pools].reverse());
    expect(forwards?.address).toBe(backwards?.address);
    expect(forwards?.address).toBe(POOL_A < POOL_B ? POOL_A : POOL_B);
  });

  it('ignores a vault that belongs to somebody else', async () => {
    // A pool can name any account as its vault. If a forged pointer at a whale's
    // vault counted as depth, the attack this function prevents would be back,
    // and cheaper — no SOL required at all.
    const { reader } = readerOver({
      [VAULT_A]: vault(WSOL_MINT, pubkey(99), 999_000_000_000n), // owned elsewhere
      [VAULT_B]: vault(WSOL_MINT, POOL_B, 1_000n),
    });

    const chosen = await reader.deepestPool([
      candidate(POOL_A, VAULT_A),
      candidate(POOL_B, VAULT_B),
    ]);
    expect(chosen?.address).toBe(POOL_B);
  });

  it('ignores a vault holding the wrong mint', async () => {
    const { reader } = readerOver({
      [VAULT_A]: vault(pubkey(77), POOL_A, 999_000_000_000n),
      [VAULT_B]: vault(WSOL_MINT, POOL_B, 1_000n),
    });

    const chosen = await reader.deepestPool([
      candidate(POOL_A, VAULT_A),
      candidate(POOL_B, VAULT_B),
    ]);
    expect(chosen?.address).toBe(POOL_B);
  });

  it('reads nothing when there is only one pool', async () => {
    // The common case must not pay for the rare one.
    const { reader, calls } = readerOver({});
    const chosen = await reader.deepestPool([candidate(POOL_A, VAULT_A)]);
    expect(chosen?.address).toBe(POOL_A);
    expect(calls()).toBe(0);
  });

  it('prices every candidate in one round trip', async () => {
    const { reader, calls } = readerOver({
      [VAULT_A]: vault(WSOL_MINT, POOL_A, 1n),
      [VAULT_B]: vault(WSOL_MINT, POOL_B, 2n),
      [VAULT_C]: vault(WSOL_MINT, POOL_C, 3n),
    });
    await reader.deepestPool([
      candidate(POOL_A, VAULT_A),
      candidate(POOL_B, VAULT_B),
      candidate(POOL_C, VAULT_C),
    ]);
    expect(calls()).toBe(1);
  });

  it('reports no market rather than guessing when every vault is unreadable', async () => {
    // Falling back to an arbitrary pool here would reinstate the bug exactly.
    const { reader } = readerOver({ [VAULT_A]: null, [VAULT_B]: null });
    const chosen = await reader.deepestPool([
      candidate(POOL_A, VAULT_A),
      candidate(POOL_B, VAULT_B),
    ]);
    expect(chosen).toBeNull();
  });

  it('has no market to choose from when there are no pools', async () => {
    const { reader } = readerOver({});
    expect(await reader.deepestPool([])).toBeNull();
  });
});
