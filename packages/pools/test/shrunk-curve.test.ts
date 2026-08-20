import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { PoolReader } from '../src/reader';
import { PUMP_PROGRAM_ID, bondingCurveAddress } from '../src/pumpfun';
import type { RpcClient } from '../src/rpc';

/**
 * A bonding curve account too small to decode.
 *
 * pump.fun shrinks the account once a token graduates. It comes back
 * forty-nine bytes long, still owned by the pump program, no longer holding
 * reserves. Decoding threw on that, and the throw took out every caller: the
 * chart warmer stopped mid-run, and the accounts trading through the engine
 * failed on any token that had graduated since it was chosen, which on pump.fun
 * is most of the interesting ones.
 *
 * It is not an ambiguous state. There is no curve left to quote, so the
 * successor pool is where trading is, exactly as for a curve that reports
 * itself complete.
 */

const MINT = bs58.encode(new Uint8Array(32).fill(7));

/** A mint account: only its decimals byte is read. */
function mintAccount(): { data: Uint8Array; owner: string; lamports: bigint; slot: number } {
  const data = new Uint8Array(82);
  data[44] = 6;
  return { data, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 0n, slot: 42 };
}

function readerWith(curveBytes: number) {
  const curveAddress = bondingCurveAddress(MINT);
  const rpc = {
    async getAccounts(addresses: readonly string[]) {
      return addresses.map((address) => {
        if (address === curveAddress) {
          return {
            data: new Uint8Array(curveBytes),
            owner: PUMP_PROGRAM_ID,
            lamports: 0n,
            slot: 42,
          };
        }
        if (address === MINT) return mintAccount();
        return null;
      });
    },
    // No pool exists for this mint in the test, which is the other half of the
    // point: an unlisted answer is a result, and throwing is not.
    async getProgramAccounts() {
      return [];
    },
  } as unknown as RpcClient;
  return new PoolReader(rpc);
}

describe('a curve account that has been shrunk', () => {
  it('reads as graduated rather than throwing', async () => {
    const resolution = await readerWith(49).resolve(MINT);

    expect(resolution.venue.kind).toBe('unlisted');
    expect(resolution.pool).toBeNull();
    expect(resolution.slot).toBe(42);
  });

  /*
   * An account of the right size that still fails to decode is a real problem
   * and has to keep failing, or a layout change would be swallowed here and
   * show up later as wrong prices.
   */
  it('still throws on a full-size account it cannot read', async () => {
    await expect(readerWith(200).resolve(MINT)).rejects.toThrow();
  });
});
