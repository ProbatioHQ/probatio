import 'server-only';
import { PRICE_SCALE, priceFromReserves } from '@probatio/candles';
import { openPositions, type AccountRow } from '@probatio/db';
import { PoolReader, RpcClient } from '@probatio/pools';
import type { Client } from '@libsql/client';
import { rpcEndpoint } from './env';

/**
 * What an account is worth, right now, for the purpose of scoring a duel.
 *
 * Deliberately the same arithmetic the leaderboard uses: SOL in hand, plus every
 * open position marked at what it is worth. A duel that invented its own idea of
 * an account's value would eventually disagree with the board about who is
 * ahead, and once two honest-looking numbers disagree, neither is worth
 * anything.
 *
 * WHY IT IS NOT THE BOARD'S OWN FUNCTION
 *
 * `seasonBoard` prices every position of every entrant in one pass and caches
 * the answer for the length of a page view. That is right for a board and wrong
 * here twice over: a duel needs two accounts, not five hundred, and it needs the
 * price *at this moment* rather than one that may be a minute old. A snapshot
 * taken from a cache is a snapshot of whenever the cache was filled.
 *
 * THE UNPRICED CASE, AND WHY IT IS COUNTED RATHER THAN HIDDEN
 *
 * A position whose pool cannot be read is counted at what it cost, which is the
 * same fallback the all-time board uses. It is not a price, though, and the
 * danger is specific: if a mint is unpriced when the duel opens and priced when
 * it closes, the difference between the two snapshots contains a jump that no
 * trade caused. So the count comes back with the figure, is stored at both ends,
 * and a duel whose result contains one says so rather than presenting a number
 * that is part measurement and part assumption.
 */

export interface Equity {
  /** SOL plus marked positions, in lamports. */
  readonly lamports: bigint;
  /** How many held positions had to be counted at cost rather than priced. */
  readonly unpriced: number;
}

/**
 * Price the open positions of one or more accounts and total each.
 *
 * Both accounts in one call on purpose. The two snapshots that open a duel have
 * to be taken at the same moment, and two sequential reads are two moments: a
 * price that moved between them would hand one trader a head start measured in
 * whatever the market did while the first read was in flight.
 */
export async function equityOf(
  client: Client,
  accounts: readonly AccountRow[],
): Promise<Equity[]> {
  const held = await Promise.all(
    accounts.map(async (account) => openPositions(client, account.id)),
  );

  const mints = [...new Set(held.flat().map((position) => position.mint))];
  const prices = new Map<string, bigint>();

  if (mints.length > 0) {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 15_000, minIntervalMs: 60 });
    const reader = new PoolReader(rpc);
    await Promise.all(
      mints.map(async (mint) => {
        try {
          const resolution = await reader.resolve(mint);
          if (!resolution.pool) return;
          prices.set(
            mint,
            priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
          );
        } catch {
          // Left unpriced, and counted as such by the caller below. Throwing
          // here would fail a settlement over one unreadable pool out of five.
        }
      }),
    );
  }

  return accounts.map((account, index) => {
    let value = BigInt(account.solBalance);
    let unpriced = 0;
    for (const position of held[index] ?? []) {
      const price = prices.get(position.mint);
      if (price === undefined) {
        value += BigInt(position.costBasis);
        unpriced += 1;
      } else {
        value += (BigInt(position.tokenAmount) * price) / PRICE_SCALE;
      }
    }
    return { lamports: value, unpriced };
  });
}
