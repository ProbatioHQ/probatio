import { TOKEN_ACCOUNT_BYTES, TOKEN_ACCOUNT_OFFSETS, TOKEN_PROGRAM_ID } from './token';
import type { RpcClient } from './rpc';

/**
 * How many wallets actually hold a token.
 *
 * The count a "at least fifty holders" rule turns on, and the most expensive
 * thing a strategy can ask for. There is no index of holders: the only way to
 * know is to match every token account whose mint is this one, which is a scan
 * of the token program.
 *
 * WHAT MAKES IT AFFORDABLE AT ALL
 *
 * Asking for eight bytes of each account instead of all hundred and sixty-five.
 * The balance lives at a fixed offset, and the node applies the slice before it
 * answers, so a token with four thousand holders comes back as thirty-two
 * kilobytes rather than six hundred. The call still costs what a program scan
 * costs; what this avoids is the response.
 *
 * WHY IT COUNTS BALANCES RATHER THAN ACCOUNTS
 *
 * A wallet that sold out is still a token account, and usually stays one: the
 * account is rent-paid and closing it is a separate transaction most people
 * never send. Counting accounts would report a token abandoned by everyone as
 * one with hundreds of holders, which is precisely backwards for a rule whose
 * whole purpose is to avoid that token.
 *
 * WHY IT IS NOT CACHED FOR LONG
 *
 * Because unlike a launch slot, this changes every few seconds on anything
 * worth buying. The caller holds it briefly so that several strategies
 * screening the same token in the same pass share one scan, and no longer.
 */

/** Zero-balance accounts are not holders. See above. */
export interface HolderCount {
  readonly holders: number;
  /** Token accounts that exist, including the emptied ones. */
  readonly accounts: number;
}

export async function holderCount(rpc: RpcClient, mint: string): Promise<HolderCount | null> {
  try {
    const accounts = await rpc.getProgramAccounts(
      TOKEN_PROGRAM_ID,
      [
        { kind: 'dataSize', bytes: TOKEN_ACCOUNT_BYTES },
        { kind: 'memcmp', offset: TOKEN_ACCOUNT_OFFSETS.mint, base58: mint },
      ],
      // The balance, and nothing else.
      { offset: TOKEN_ACCOUNT_OFFSETS.amount, length: 8 },
    );

    let holders = 0;
    for (const entry of accounts) {
      const data = entry.account.data;
      if (data.length < 8) continue;
      const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0, true);
      if (amount > 0n) holders += 1;
    }

    return { holders, accounts: accounts.length };
  } catch {
    /*
     * Null rather than zero. A scan that failed is not a token nobody holds,
     * and zero is the answer that fails a minimum-holders rule — which is the
     * safe direction here, but only because the rule treats null as unmet
     * rather than converting it.
     */
    return null;
  }
}
