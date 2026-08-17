import 'server-only';
import { PUMPFUN_TOKEN_TOTAL_SUPPLY, bondingCurveAddress, decodeBondingCurve } from '@probatio/pools';
import { marketCapLamports, priceFromReserves } from '@probatio/candles';
import { sharedRpc } from './rpc';

/**
 * Market caps for tokens the feed has not priced yet.
 *
 * A launch only carries a curve once something has read one, and the watcher
 * rotates a fixed budget across the whole feed, so a token minutes old is
 * routinely still unread. Search then showed it as "n/a", which is the honest
 * word for an unknown value and the wrong thing to show somebody who has just
 * typed a name and is looking at a list of numbers with a gap in it.
 *
 * The curve is on chain and every one of these is a fixed-size account at an
 * address derived from the mint, so a whole page of them is one batched read
 * rather than one per token. Bounded by the size of the page being shown.
 *
 * Best-effort and display-only. A failure leaves the value unknown, which is
 * what it was; nothing here is ever quoted to a fill.
 */

/** Never read more than a page's worth, whatever a caller passes. */
const MAX_LOOKUPS = 40;

export async function capsFromChain(mints: readonly string[]): Promise<Map<string, string>> {
  const caps = new Map<string, string>();
  const wanted = [...new Set(mints)].slice(0, MAX_LOOKUPS);
  if (wanted.length === 0) return caps;

  try {
    const accounts = await sharedRpc().getAccounts(wanted.map(bondingCurveAddress));
    wanted.forEach((mint, index) => {
      const account = accounts[index];
      if (!account) return;
      try {
        const curve = decodeBondingCurve(account.data);
        /*
         * Only while the token is still on its curve.
         *
         * A graduated curve keeps the reserves it held at graduation, so
         * pricing from it quotes what the token was worth the day it bonded,
         * whatever it has done since. That is not an unknown value, it is a
         * wrong one, and a wrong number shown confidently is worse than the
         * gap it fills. Graduated tokens are priced from their pool elsewhere.
         */
        if (curve.complete) return;
        if (curve.virtualTokenReserves <= 0n || curve.virtualSolReserves <= 0n) return;
        const price = priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves);
        caps.set(mint, marketCapLamports(price, PUMPFUN_TOKEN_TOTAL_SUPPLY).toString());
      } catch {
        // A graduated token's curve is closed, and an account that is not a
        // curve is not one. Either way this token keeps whatever it had.
      }
    });
  } catch {
    // The chain could not be reached. Every caller renders an unknown value the
    // way it already did.
  }

  return caps;
}

/**
 * Market caps from the index, for tokens no curve can price.
 *
 * Two kinds of token fall through the curve read and both are real. A graduated
 * one has a curve whose reserves are zeroed, so there is nothing on it to price
 * from and its market now lives in a pool. A token that never came from
 * pump.fun has no curve at all. Both were showing as unknown next to results
 * that had a number.
 *
 * One call for the whole page: the index takes a list of mints and answers for
 * all of them at once, so this costs the same whether one token needs it or
 * thirty. Display only, like everything else here.
 */
const INDEX_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens';
/** The index's own ceiling on how many addresses one call may carry. */
const MAX_INDEXED = 30;

export async function capsFromIndex(
  mints: readonly string[],
  solUsd: number | null,
): Promise<Map<string, string>> {
  const caps = new Map<string, string>();
  const wanted = [...new Set(mints)].slice(0, MAX_INDEXED);
  if (wanted.length === 0 || !solUsd || solUsd <= 0) return caps;

  try {
    const response = await fetch(`${INDEX_TOKENS}/${wanted.join(',')}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return caps;
    const body = (await response.json()) as { pairs?: unknown };
    if (!Array.isArray(body.pairs)) return caps;

    for (const entry of body.pairs) {
      const pair = entry as {
        baseToken?: { address?: unknown };
        marketCap?: unknown;
        fdv?: unknown;
      };
      const mint = String(pair.baseToken?.address ?? '');
      if (!mint || caps.has(mint)) continue;
      // Market cap where the index has it, fully diluted where it does not.
      const usd = Number(pair.marketCap ?? pair.fdv ?? 0);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      caps.set(mint, Math.round((usd / solUsd) * 1e9).toString());
    }
  } catch {
    // Unreachable or slow. The tokens it would have priced stay unknown.
  }

  return caps;
}
