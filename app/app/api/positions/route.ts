import { PoolReader, RpcClient } from '@probatio/pools';
import { PRICE_SCALE, priceFromReserves } from '@probatio/candles';
import { accountEquity, valuePosition, type ValuedPosition } from '@probatio/trading';
import {
  openPositions,
  totalRealizedPnl,
} from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';
import { rpcEndpoint } from '@/lib/env';

/**
 * Positions, marked to the market right now.
 *
 * Unrealized profit is only meaningful against a live price, so each held
 * token is read from chain. That is one read per open position, which is the
 * highest-priority case in the subscription budget precisely because a stale
 * position figure is worse than a stale chart.
 *
 * A token that cannot be priced is returned with a null price rather than
 * silently valued at zero. Marking a position to nothing because an RPC call
 * failed would show a trader a wipeout that never happened.
 */

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'chainRead');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) {
    return Response.json({ error: 'sign in to see your positions' }, { status: 401 });
  }

  const client = await db();
  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, user.pubkey, now);

  const positions = await openPositions(client, account.id);
  const realized = await totalRealizedPnl(client, account.id);

  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 15_000 });
  const reader = new PoolReader(rpc);

  const priced = await Promise.all(
    positions.map(async (position) => {
      try {
        const resolution = await reader.resolve(position.mint);
        if (!resolution.pool) return { position, price: null };
        return {
          position,
          price: priceFromReserves(resolution.pool.solReserve, resolution.pool.tokenReserve),
        };
      } catch {
        return { position, price: null };
      }
    }),
  );

  const valued: ValuedPosition[] = priced
    .filter((entry) => entry.price !== null)
    .map((entry) =>
      valuePosition(
        {
          mint: entry.position.mint,
          tokenAmount: BigInt(entry.position.tokenAmount),
          costBasis: BigInt(entry.position.costBasis),
          realizedPnl: BigInt(entry.position.realizedPnl),
        },
        entry.price!,
        PRICE_SCALE,
      ),
    );

  const equity = accountEquity(
    BigInt(account.solBalance),
    valued,
    BigInt(realized),
    BigInt(account.startingBalance),
  );

  return Response.json({
    balance: account.solBalance,
    startingBalance: account.startingBalance,
    equity: {
      cash: equity.cash.toString(),
      positionValue: equity.positionValue.toString(),
      equity: equity.equity.toString(),
      realized: equity.realized.toString(),
      unrealized: equity.unrealized.toString(),
      totalPnl: equity.totalPnl.toString(),
      returnBps: equity.returnBps,
    },
    positions: priced.map((entry) => {
      const value =
        entry.price === null
          ? null
          : valuePosition(
              {
                mint: entry.position.mint,
                tokenAmount: BigInt(entry.position.tokenAmount),
                costBasis: BigInt(entry.position.costBasis),
                realizedPnl: BigInt(entry.position.realizedPnl),
              },
              entry.price,
              PRICE_SCALE,
            ).value;

      return {
        mint: entry.position.mint,
        tokenAmount: entry.position.tokenAmount,
        costBasis: entry.position.costBasis,
        realizedPnl: entry.position.realizedPnl,
        // Null means the price could not be read, not that it is worthless.
        value: value === null ? null : value.toString(),
        unrealized:
          value === null ? null : (value - BigInt(entry.position.costBasis)).toString(),
        price: entry.price === null ? null : entry.price.toString(),
      };
    }),
  });
}
