import 'server-only';
import { PoolReader, RpcClient, type Resolution } from '@probatio/pools';
import { rpcEndpoint } from './env';

/**
 * One RPC client for the request paths, shared across every request.
 *
 * The trade route used to build a fresh client per request, which defeated the
 * two things the client does to be a good citizen: its pacing cursor and its
 * backoff are per-instance, so hundreds of one-shot clients neither spaced their
 * requests out nor coordinated a retreat when the endpoint started refusing. A
 * launch crowd on one token then became a call storm with no ceiling. Shared,
 * pacing and backoff hold across the whole crowd, and the in-flight cap keeps a
 * spike from opening sockets without bound.
 *
 * The workers keep their own clients on purpose: their pacing is tuned for a
 * steady background sweep, not for a user waiting on a click.
 */

/** In-flight request-path RPC calls allowed at once, across all requests. */
const MAX_CONCURRENT = 24;

let rpc: RpcClient | undefined;
let reader: PoolReader | undefined;

export function sharedRpc(): RpcClient {
  rpc ??= new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 15_000,
    // Someone is waiting on this. One quick retry, then fail fast to a clean
    // 503 and let them re-click, rather than hold the request open through a
    // retry storm against an endpoint that is already saying no.
    maxRetries: 1,
    minIntervalMs: 20,
    maxConcurrent: MAX_CONCURRENT,
  });
  return rpc;
}

export function sharedReader(): PoolReader {
  reader ??= new PoolReader(sharedRpc());
  return reader;
}

/**
 * Read a token's live market, collapsing concurrent identical reads into one.
 *
 * Five hundred people opening the same fresh token in the same instant would
 * otherwise be five hundred reads of one identical curve account. Here they
 * share a single in-flight read. It is not a cache: the shared promise is
 * dropped the moment it settles, so nobody is handed a stale price, only the
 * same fresh one everyone was about to fetch anyway.
 *
 * For the read a trade takes at the click, and for anywhere a current price is
 * wanted. NOT for the read that settles a fill — see `resolveFill`.
 */
const inflight = new Map<string, Promise<Resolution>>();

export function resolveMint(mint: string): Promise<Resolution> {
  const existing = inflight.get(mint);
  if (existing) return existing;

  const pending = sharedReader()
    .resolve(mint)
    .finally(() => {
      inflight.delete(mint);
    });
  inflight.set(mint, pending);
  return pending;
}

/**
 * Read a token's live market fresh, never sharing another read.
 *
 * The read that settles a fill happens after the honest delay, and it has to
 * reflect a read taken after that delay — the whole engine exists to deny a
 * trader the price they saw before waiting. Coalescing would let a fill latch
 * onto a read already in flight, which by definition began earlier and could
 * carry a price from before this trade's delay elapsed — handing back exactly
 * the pre-delay execution the delay is there to prevent. So the fill never
 * shares: correctness of the delay outranks collapsing duplicate fills, and the
 * shared client's in-flight cap still bounds the load a crowd of fills makes.
 */
export function resolveFill(mint: string): Promise<Resolution> {
  return sharedReader().resolve(mint);
}
