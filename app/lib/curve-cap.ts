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
