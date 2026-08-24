import { describe, expect, it } from 'vitest';
import { holderCount } from '../src/holders';
import { TOKEN_ACCOUNT_BYTES, TOKEN_ACCOUNT_OFFSETS, TOKEN_PROGRAM_ID } from '../src/token';
import type { RpcClient } from '../src/rpc';

/**
 * Counting who actually holds a token.
 *
 * Two things decide whether this number is worth screening on: that it counts
 * balances rather than accounts, and that it asks the node for eight bytes
 * rather than a hundred and sixty-five.
 */

const MINT = 'D3KxoUnQdZZUnQcpmxb9Ktb26rDndURseog6DPsVpump';

/** An account as the node returns it under a data slice: the balance alone. */
function sliced(amount: bigint) {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setBigUint64(0, amount, true);
  return { address: 'x', account: { data, owner: TOKEN_PROGRAM_ID, lamports: 0n, slot: 1 } };
}

function chainOf(amounts: bigint[], onCall?: (args: unknown[]) => void) {
  const rpc = {
    async getProgramAccounts(
      programId: string,
      filters: unknown[],
      dataSlice?: { offset: number; length: number },
    ) {
      onCall?.([programId, filters, dataSlice]);
      return amounts.map(sliced);
    },
  } as unknown as RpcClient;
  return rpc;
}

describe('holder count', () => {
  it('counts wallets with a balance, not token accounts', async () => {
    /*
     * A wallet that sold out keeps its token account: closing one is a separate
     * transaction almost nobody sends. Counting accounts would report a token
     * everybody abandoned as one with plenty of holders, which is exactly
     * backwards for the rule this feeds.
     */
    const found = await holderCount(chainOf([100n, 0n, 5n, 0n, 0n, 1n]), MINT);
    expect(found).toEqual({ holders: 3, accounts: 6 });
  });

  it('asks the node for the balance alone', async () => {
    let seen: unknown[] = [];
    await holderCount(chainOf([1n], (args) => { seen = args; }), MINT);

    const [programId, filters, dataSlice] = seen as [string, unknown[], unknown];
    expect(programId).toBe(TOKEN_PROGRAM_ID);
    // Eight bytes each instead of a hundred and sixty-five: on a token with
    // four thousand holders that is thirty-two kilobytes rather than six
    // hundred, and the node applies it before answering.
    expect(dataSlice).toEqual({ offset: TOKEN_ACCOUNT_OFFSETS.amount, length: 8 });
    expect(filters).toEqual([
      { kind: 'dataSize', bytes: TOKEN_ACCOUNT_BYTES },
      { kind: 'memcmp', offset: TOKEN_ACCOUNT_OFFSETS.mint, base58: MINT },
    ]);
  });

  it('reports nothing rather than none when the scan fails', async () => {
    const broken = {
      async getProgramAccounts() { throw new Error('429'); },
    } as unknown as RpcClient;

    // A scan that did not finish is not a token nobody holds.
    expect(await holderCount(broken, MINT)).toBeNull();
  });

  it('reports a real zero for a token nobody holds', async () => {
    expect(await holderCount(chainOf([0n, 0n]), MINT)).toEqual({ holders: 0, accounts: 2 });
  });
});
