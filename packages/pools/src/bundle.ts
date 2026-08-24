import { extractTradeEvents } from './events';
import { PUMPFUN_TOKEN_TOTAL_SUPPLY } from './pumpfun';
import type { RpcClient } from './rpc';

/**
 * How much of a token was taken in the slot it was created in.
 *
 * A pump.fun launch that matters to a trader is usually not one transaction. The
 * creator lands the create and a set of buys together, in one Jito bundle, so
 * they are filled before anybody watching the chain can react. What comes out
 * the other side looks like a token with instant volume and is a token whose
 * supply already belongs to whoever paid for the bundle.
 *
 * That is what this measures: every buy the program logged in the same slot as
 * the create, as a share of the supply. Not "who is bundled with whom", which
 * needs wallet clustering nobody can do reliably, but the plainer fact that
 * everything bought in the launch slot was bought by somebody who was not
 * racing for it.
 *
 * WHY IT IS WORTH READING THE CHAIN FOR
 *
 * Because unlike every other condition, the answer never changes. A token's
 * launch slot is over. So this is paid for once per mint, ever, and stored;
 * a second strategy asking about the same token costs nothing at all.
 *
 * WHAT IT DELIBERATELY WILL NOT DO
 *
 * Walk a long history. The signatures on a curve are read newest first and the
 * create is the oldest, so an established token would mean paging back through
 * thousands of trades to answer a question about its first second. That is
 * bounded here, and a token past the bound returns null rather than a number
 * bought at an unreasonable price. Strategies screen new launches, where the
 * walk is a page or two.
 */

/**
 * The most signatures to page through looking for the create.
 *
 * Six hundred is a handful of pages, and covers a launch busy enough to be
 * interesting for its first minutes. Past that a token is not new, which is the
 * only case this exists to answer about.
 */
const MAX_SIGNATURES = 600;
const PAGE = 200;

export interface LaunchBundle {
  /** The slot the token was created in. */
  readonly slot: number;
  /** Tokens bought in that slot, in base units. */
  readonly boughtTokens: bigint;
  /** That, as a share of the supply, in basis points. */
  readonly bundledBps: number;
  /** How many buys landed in the launch slot. One is an ordinary dev buy. */
  readonly buys: number;
}

/**
 * Read a token's launch slot and total what was bought in it.
 *
 * Null when the create could not be reached inside the bound, or when the chain
 * could not be read. Null is not zero, and callers must not treat it as a clean
 * launch: nothing bought in the launch slot and nothing known about the launch
 * slot are opposite facts.
 */
export async function launchBundle(
  rpc: RpcClient,
  curveAddress: string,
): Promise<LaunchBundle | null> {
  const signatures: { signature: string; slot: number }[] = [];
  let before: string | undefined;

  while (signatures.length < MAX_SIGNATURES) {
    const page = await rpc.getSignatures(curveAddress, {
      limit: Math.min(PAGE, MAX_SIGNATURES - signatures.length),
      ...(before ? { before } : {}),
    });
    if (page.length === 0) break;

    for (const entry of page) {
      // A reverted transaction bought nothing.
      if (entry.err === null) signatures.push({ signature: entry.signature, slot: entry.slot });
    }

    const last = page[page.length - 1];
    if (!last || page.length < PAGE) {
      // A short page is the end of the history, so the oldest signature here is
      // the create and the walk is complete.
      before = undefined;
      break;
    }
    before = last.signature;
  }

  if (signatures.length === 0) return null;
  /*
   * A full walk that never ran out means the create is further back than the
   * bound allows. Answering from the oldest signature seen would report some
   * arbitrary later slot as the launch, which is a wrong number rather than a
   * missing one.
   */
  if (before !== undefined) return null;

  const oldest = signatures[signatures.length - 1]!;
  const launchSlot = oldest.slot;
  const inSlot = signatures.filter((entry) => entry.slot === launchSlot);

  let boughtTokens = 0n;
  let buys = 0;

  for (const entry of inSlot) {
    const logs = await rpc.getTransactionLogs(entry.signature);
    if (!logs) continue;
    for (const event of extractTradeEvents(logs.logMessages)) {
      if (!event.isBuy) continue;
      boughtTokens += event.tokenAmount;
      buys += 1;
    }
  }

  return {
    slot: launchSlot,
    boughtTokens,
    bundledBps: Number((boughtTokens * 10_000n) / PUMPFUN_TOKEN_TOTAL_SUPPLY),
    buys,
  };
}
