import 'server-only';
import { AccountSubscription, toWebSocketUrl } from '@probatio/feed';
import {
  PoolReader,
  RpcClient,
  bondingCurveAddress,
  decodeBondingCurve,
  decodeTokenAccount,
  pumpSwapReserveOffset,
} from '@probatio/pools';
import { priceFromReserves } from '@probatio/candles';
import { recentlyViewed } from './watched';
import { rpcEndpoint } from './env';

/**
 * Prices pushed the moment they change.
 *
 * The watcher polls, and polling has a floor. A token being looked at was
 * re-read every twelve seconds at best, which meant a chart could be twelve
 * seconds wrong about a market that moves in one — and a trader watching the
 * same coin on pump.fun would see it move here second. The number was never
 * wrong for a *fill*, which reads the chain when the click arrives, but a
 * display that lags is its own problem and this removes the floor rather than
 * lowering it.
 *
 * The node pushes an account whenever it changes. For a token on its bonding
 * curve that account is the curve itself, and its address derives from the mint
 * — so a brand new launch can be watched without asking anyone anything, which
 * is exactly the case that matters most here. For a graduated token the
 * reserves are two ordinary token accounts, so the pool has to be found first
 * and is remembered afterwards.
 *
 * Only tokens somebody has open are watched, and they are dropped when nobody
 * is looking. A subscription costs the node nothing to hold and everything to
 * hold a thousand of.
 */

/** How often the watched set is reconciled against what is subscribed. */
const RECONCILE_MS = 5_000;
/** A ceiling on live subscriptions, whatever the traffic. */
const MAX_SUBSCRIPTIONS = 48;

export interface LivePrice {
  readonly mint: string;
  /** Lamports per token base unit, scaled by 1e18 — the same unit as a candle. */
  readonly price: bigint;
  readonly solReserve: bigint;
  readonly tokenReserve: bigint;
  readonly slot: number | null;
  readonly at: number;
}

type Listener = (price: LivePrice) => void;

interface StreamState {
  started: boolean;
  subscription: AccountSubscription | null;
  timer: ReturnType<typeof setInterval> | null;
  /** Account address → which mint it prices, and which side it is. */
  accounts: Map<string, { mint: string; side: 'curve' | 'base' | 'quote' }>;
  /** Mint → the accounts being watched for it. */
  watching: Map<string, string[]>;
  /**
   * Mint → the last reserves seen, with the slot each side was read at.
   *
   * The two sides carry their own slot because a pool's two vaults arrive as
   * separate account updates, and a price is only real when both are from the
   * same swap. Pricing a new SOL reserve against a stale token reserve is what
   * made the live bar flip between the true price and a wrong one.
   */
  reserves: Map<
    string,
    { sol: bigint; token: bigint; offset: bigint; solSlot: number; tokenSlot: number }
  >;
  /** Mint → the most recent price, for a client that connects mid-stream. */
  latest: Map<string, LivePrice>;
  listeners: Set<Listener>;
  connected: boolean;
}

/**
 * Shared across bundles, for the reason in lib/health.ts. The SSE route and the
 * instrumentation that starts this compile separately, and a per-bundle copy
 * means a second socket subscribing to the same accounts while the route
 * listens to the one nobody is feeding.
 */
const STREAM_KEY = Symbol.for('probatio.price-stream');

function state(): StreamState {
  const store = globalThis as typeof globalThis & { [STREAM_KEY]?: StreamState };
  store[STREAM_KEY] ??= {
    started: false,
    subscription: null,
    timer: null,
    accounts: new Map(),
    watching: new Map(),
    reserves: new Map(),
    latest: new Map(),
    listeners: new Set(),
    connected: false,
  };
  return store[STREAM_KEY];
}

/** Listen for pushed prices. Returns the unsubscribe. */
export function onLivePrice(listener: Listener): () => void {
  const current = state();
  current.listeners.add(listener);
  return () => current.listeners.delete(listener);
}

/** The last price pushed for a mint, if any. */
export function lastLivePrice(mint: string): LivePrice | null {
  return state().latest.get(mint) ?? null;
}

export function priceStreamStatus(): {
  running: boolean;
  connected: boolean;
  mints: number;
  accounts: number;
  listeners: number;
} {
  const current = state();
  return {
    running: current.started,
    connected: current.connected,
    mints: current.watching.size,
    accounts: current.accounts.size,
    listeners: current.listeners.size,
  };
}

function publish(price: LivePrice): void {
  const current = state();
  current.latest.set(price.mint, price);
  for (const listener of current.listeners) {
    try {
      listener(price);
    } catch {
      // One bad listener must not stop the others being told.
    }
  }
}

/** Recompute and publish once both sides of a market are known. */
function priceFrom(mint: string, slot: number | null): void {
  const current = state();
  const held = current.reserves.get(mint);
  if (!held || held.token <= 0n) return;

  // Both sides from the same swap, or not a price. A pool updates its two vaults
  // in one transaction, so their slots match once both notifications land;
  // between them the pair is inconsistent and must not be published.
  if (held.solSlot !== held.tokenSlot) return;

  const sol = held.sol + held.offset;
  if (sol <= 0n) return;

  publish({
    mint,
    // The same function the candles and the fill engine use. A price that
    // reached a chart by another route would be a second opinion.
    price: priceFromReserves(sol, held.token),
    solReserve: sol,
    tokenReserve: held.token,
    slot,
    at: Date.now(),
  });
}

function handleUpdate(address: string, data: Uint8Array, slot: number | null): void {
  const current = state();
  const target = current.accounts.get(address);
  if (!target) return;

  const held =
    current.reserves.get(target.mint) ??
    { sol: 0n, token: 0n, offset: 0n, solSlot: 0, tokenSlot: 0 };
  const at = slot ?? 0;

  try {
    if (target.side === 'curve') {
      const curve = decodeBondingCurve(data);
      // A completed curve prices nothing; the token moved to a pool and the
      // reconciler will pick that up on its next pass.
      if (curve.complete) return;
      // A curve carries both reserves in one account, so the two sides are
      // always from the same read.
      held.sol = curve.virtualSolReserves;
      held.token = curve.virtualTokenReserves;
      held.offset = 0n;
      held.solSlot = at;
      held.tokenSlot = at;
    } else if (target.side === 'quote') {
      held.sol = decodeTokenAccount(data).amount;
      held.solSlot = at;
    } else {
      held.token = decodeTokenAccount(data).amount;
      held.tokenSlot = at;
    }
  } catch {
    return;
  }

  current.reserves.set(target.mint, held);
  priceFrom(target.mint, slot);
}

/** Which accounts price this mint, and its starting reserves. */
async function accountsFor(
  reader: PoolReader,
  rpc: RpcClient,
  mint: string,
): Promise<{ accounts: { address: string; side: 'curve' | 'base' | 'quote' }[]; sol: bigint; token: bigint; offset: bigint } | null> {
  const curveAddress = bondingCurveAddress(mint);
  const [curveAccount] = await rpc.getAccounts([curveAddress]);
  if (!curveAccount) return null;

  const curve = decodeBondingCurve(curveAccount.data);
  if (!curve.complete) {
    return {
      accounts: [{ address: curveAddress, side: 'curve' }],
      sol: curve.virtualSolReserves,
      token: curve.virtualTokenReserves,
      offset: 0n,
    };
  }

  const pools = await reader.findPumpSwapPools(mint);
  const pool = await reader.deepestPool(pools);
  if (!pool) return null;

  const [poolAccount, base, quote] = await rpc.getAccounts([
    pool.address,
    pool.pool.baseVault,
    pool.pool.quoteVault,
  ]);
  if (!base || !quote) return null;

  return {
    accounts: [
      { address: pool.pool.baseVault, side: 'base' },
      { address: pool.pool.quoteVault, side: 'quote' },
    ],
    sol: decodeTokenAccount(quote.data).amount,
    token: decodeTokenAccount(base.data).amount,
    // Some pools price against more SOL than they hold. Read once here: it
    // moves far more slowly than the reserves, and re-reading it on every push
    // would put an RPC call in the path this exists to keep out of.
    offset: poolAccount ? pumpSwapReserveOffset(poolAccount.data) : 0n,
  };
}

function stopWatching(mint: string): void {
  const current = state();
  for (const address of current.watching.get(mint) ?? []) {
    current.subscription?.unwatch(address);
    current.accounts.delete(address);
  }
  current.watching.delete(mint);
  current.reserves.delete(mint);
  current.latest.delete(mint);
}

/** Bring the subscriptions in line with what people are looking at. */
async function reconcile(reader: PoolReader, rpc: RpcClient): Promise<void> {
  const current = state();
  if (!current.subscription) return;

  const wanted = recentlyViewed().slice(0, MAX_SUBSCRIPTIONS);
  const wantedSet = new Set(wanted);

  for (const mint of [...current.watching.keys()]) {
    if (!wantedSet.has(mint)) stopWatching(mint);
  }

  for (const mint of wanted) {
    if (current.watching.has(mint)) continue;
    // Claimed before the await, so two passes cannot both resolve the same mint.
    current.watching.set(mint, []);

    try {
      const found = await accountsFor(reader, rpc, mint);
      if (!found) {
        current.watching.delete(mint);
        continue;
      }

      // One getAccounts read, so both sides share a slot and the first price
      // publishes immediately.
      current.reserves.set(mint, {
        sol: found.sol,
        token: found.token,
        offset: found.offset,
        solSlot: 0,
        tokenSlot: 0,
      });
      current.watching.set(
        mint,
        found.accounts.map((entry) => entry.address),
      );
      for (const entry of found.accounts) {
        current.accounts.set(entry.address, { mint, side: entry.side });
        current.subscription.watch(entry.address);
      }
      // Publish what is already known, so a chart does not wait for the next
      // trade to show a price it could have had immediately.
      priceFrom(mint, null);
    } catch {
      current.watching.delete(mint);
    }
  }
}

export function startPriceStream(): void {
  const current = state();
  if (current.started) return;
  current.started = true;

  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000, minIntervalMs: 150 });
  const reader = new PoolReader(rpc);

  current.subscription = new AccountSubscription({
    endpoint: toWebSocketUrl(rpcEndpoint()),
    onUpdate: ({ address, data, slot }) => handleUpdate(address, data, slot),
    onStatus: (status) => {
      current.connected = status === 'open' || status === 'subscribed';
      if (status === 'open') console.log('[prices] live');
    },
  });
  current.subscription.start();

  const tick = (): void => {
    void reconcile(reader, rpc).catch((error) => {
      console.error('[prices] reconcile failed', error);
    });
  };

  tick();
  current.timer = setInterval(tick, RECONCILE_MS);
  current.timer.unref?.();
}
