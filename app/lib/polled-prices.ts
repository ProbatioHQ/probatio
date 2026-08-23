import 'server-only';
import type { Observation } from '@probatio/candles';
import { onLivePrice, publishPolledPrice } from './price-stream';
import { ingestObservations } from './trade-candles';
import { recentlyViewed } from './watched';

/**
 * Prices for whoever is looking, read from pump.fun rather than the chain.
 *
 * The live price used to come from a websocket subscription to the token's pool
 * accounts, which is the best source there is: it is the same reserves the fill
 * engine quotes against, and it moves the instant a swap lands. It is also a
 * per-token subscription against a paid RPC, and it was among the first things
 * switched off when the credit ceiling was reached. With it off, a chart opened
 * and then sat at whatever the twelve-second poll last wrote.
 *
 * This is the same trade the launch feed already made: a free, slower source in
 * place of an expensive, exact one. pump.fun publishes a one-minute candle per
 * token and it is the same series the site's charts are drawn from, so the
 * price a viewer sees here is the price pump.fun shows them.
 *
 * What it is not: the number a fill is quoted at. A trade reads the pool when
 * the click arrives and always has, which is why a slower display price costs
 * accuracy in the chart and nothing at all in a fill.
 */

const CANDLES = 'https://swap-api.pump.fun/v1/coins';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

/** How often to ask. */
const INTERVAL_MS = 6_000;

/**
 * How many tokens to price per pass.
 *
 * One request each, so this is a request rate against somebody else's service:
 * eight every six seconds. The watched set is usually far smaller, and the cap
 * exists for the case where it is not.
 */
const MAX_PER_PASS = 8;

/**
 * How long the subscription source is trusted after it last spoke.
 *
 * When the websocket is running it is better than this in every way, so this
 * stays out of its way and only prices tokens it has not heard about recently.
 */
const DEFER_MS = 20_000;

interface Store {
  timer: ReturnType<typeof setInterval> | null;
  /** When the live subscription last published, per mint. */
  seen: Map<string, number>;
  unsubscribe: (() => void) | null;
}

/*
 * Shared across bundles for the reason written out in lib/health.ts: this is
 * reached from a route and from instrumentation, and a per-bundle copy would
 * poll the same tokens twice.
 */
const KEY = Symbol.for('probatio.polled-prices');

function store(): Store {
  const global = globalThis as unknown as Record<symbol, Store | undefined>;
  const existing = global[KEY];
  if (existing) return existing;
  const fresh: Store = { timer: null, seen: new Map(), unsubscribe: null };
  global[KEY] = fresh;
  return fresh;
}

/** The newest close for a token, in the same unit a candle carries. */
async function latestPrice(mint: string): Promise<bigint | null> {
  try {
    const url = `${CANDLES}/${mint}/candles?interval=1m&limit=1&currency=SOL`;
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://pump.fun' },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });
    if (!response.ok) return null;

    const body = (await response.json()) as unknown;
    if (!Array.isArray(body) || body.length === 0) return null;

    const close = Number((body[body.length - 1] as Record<string, unknown>)['close']);
    if (!Number.isFinite(close) || close <= 0) return null;

    /*
     * SOL per token, into lamports per token base unit scaled by 1e18, which is
     * the unit every candle and every quote on this site already uses. Done in
     * one multiplication so the rounding happens once, at the end.
     */
    return BigInt(Math.round(close * 1e9 * 1e18 / 1e6));
  } catch {
    return null;
  }
}

async function pass(): Promise<void> {
  const current = store();
  const now = Date.now();

  const mints = recentlyViewed(now)
    // Nobody is looking, nothing to price.
    .filter((mint) => {
      const heard = current.seen.get(mint) ?? 0;
      // The subscription is better whenever it is working, so defer to it.
      return now - heard > DEFER_MS;
    })
    .slice(0, MAX_PER_PASS);

  if (mints.length === 0) return;

  await Promise.all(
    mints.map(async (mint) => {
      const price = await latestPrice(mint);
      if (price === null) return;
      publishPolledPrice(mint, price, now);

      /*
       * Record it as a candle too, for the same reason the chain path does.
       *
       * Pushing the price only to the stream fixed the live bar and nothing
       * else. Every other number on a token page is read back out of the candle
       * store — the header figure, the percent change, the mark a position is
       * valued at — and for a graduated token with the subscription off, the
       * only thing writing that store is an eight-minute history refresh. So
       * the chart's last bar moved while the price above it sat still, and
       * every candle poll stamped the stale close back over the live one. The
       * hitch was those two disagreeing three times a second.
       *
       * No volume: this is a price observed, not a trade seen. The type allows
       * that explicitly, and claiming volume nobody moved would put a number in
       * the chart that no swap backs.
       */
      const observation: Observation = {
        timestamp: Math.floor(now / 1_000),
        price,
        volumeLamports: 0n,
      };
      ingestObservations(mint, [observation]);
    }),
  );
}

export function startPolledPrices(): void {
  const current = store();
  if (current.timer) return;

  // Whenever the real subscription speaks, note it and stay out of its way.
  current.unsubscribe = onLivePrice((price) => {
    if (price.source === 'chain') store().seen.set(price.mint, price.at);
  });

  const tick = (): void => {
    void pass().catch((error) => {
      console.error('[prices] polled pass failed', error);
    });
  };

  tick();
  current.timer = setInterval(tick, INTERVAL_MS);
  current.timer.unref?.();
  console.log('[prices] polling pump.fun for watched tokens');
}
