import 'server-only';
import { STORED_TIMEFRAMES, buildCandles, observationFromEvent, type Observation, type Timeframe } from '@probatio/candles';
import { writeCandles } from '@probatio/db';
import type { TradeEvent } from '@probatio/pools';
import { db } from './db';

/**
 * Charts built from trades, not from glances.
 *
 * The curve watcher samples a price every few seconds, which is enough to know
 * roughly where a token is but is the wrong input for a candle: one sample per
 * bucket means open, high, low and close are all the same number, and every
 * candle draws as a flat line. A chart made of flat lines is not a chart.
 *
 * The websocket that reports launches carries every pump.fun trade too — same
 * subscription, same messages, already arriving. Each one names the reserves
 * after it, so the price is read rather than estimated and the volume is the
 * SOL that actually moved. That is what a candle is made of.
 *
 * Buffered rather than written per trade. A busy minute is thousands of
 * events, and a write each would be a write storm for a chart nobody is
 * looking at yet.
 */

/** Held before writing. Long enough to batch, short enough to stay live. */
const FLUSH_INTERVAL_MS = 3_000;
/**
 * A ceiling on how many mints are buffered between flushes.
 *
 * pump.fun can produce trades across more tokens than are worth charting in
 * any one window. Dropping the overflow costs a candle on a token nobody
 * asked for; growing without limit costs the process.
 */
const MAX_MINTS = 400;
/**
 * A ceiling per mint, per flush window.
 *
 * The mint count was bounded and the array behind each one was not, so a token
 * being hammered could accumulate without limit between flushes. The candle a
 * window produces is the same whether it saw two hundred trades or two
 * thousand — the open, the extremes and the close are already fixed by the
 * first few hundred — so the tail costs memory and buys nothing.
 */
const MAX_PER_MINT = 500;

/**
 * On `globalThis`, for the reason written out in lib/health.ts.
 *
 * This buffer is filled by the websocket in the instrumentation bundle and was
 * read by the health route in another, so `bufferedTradeMints` reported zero
 * always. Measured: two hundred and thirty-four candles written in twelve
 * seconds while health insisted nothing was buffered.
 *
 * That is worse than having no metric. It was added so a silent failure in the
 * trade pipeline would be visible, and instead it was an instrument reading
 * empty while thousands of observations flowed past it — the exact shape of
 * reassuring lie it existed to prevent.
 */
interface TradeBuffer {
  pending: Map<string, Observation[]>;
  timer: ReturnType<typeof setInterval> | null;
  flushing: boolean;
}

const BUFFER_KEY = Symbol.for('probatio.trade-candles');

function buffer(): TradeBuffer {
  const store = globalThis as typeof globalThis & { [BUFFER_KEY]?: TradeBuffer };
  store[BUFFER_KEY] ??= { pending: new Map(), timer: null, flushing: false };
  return store[BUFFER_KEY];
}

/**
 * Buffer observations that did not come from a curve trade event.
 *
 * A graduated token trades on a pool, not the curve, so its trades never reach
 * `ingestTradeEvents`. The price stream sees every one of those swaps over its
 * account subscription and builds a price from it the same way; this lets it
 * drop those into the same buffer, so a graduated chart fills in per trade
 * rather than per poll. Same bounds, same flush.
 */
export function ingestObservations(mint: string, incoming: readonly Observation[]): void {
  if (incoming.length === 0) return;
  const { pending } = buffer();
  let observations = pending.get(mint);
  if (!observations) {
    if (pending.size >= MAX_MINTS) return;
    observations = [];
    pending.set(mint, observations);
  }
  for (const observation of incoming) {
    if (observations.length >= MAX_PER_MINT) break;
    observations.push(observation);
  }
}

export function ingestTradeEvents(events: readonly TradeEvent[]): void {
  const { pending } = buffer();
  for (const event of events) {
    let observations = pending.get(event.mint);
    if (!observations) {
      if (pending.size >= MAX_MINTS) continue;
      observations = [];
      pending.set(event.mint, observations);
    }
    if (observations.length >= MAX_PER_MINT) continue;
    // The same reserves the fill engine quotes against, so a chart and a fill
    // can never disagree about what the price was.
    observations.push(observationFromEvent(event));
  }
}

async function flush(): Promise<void> {
  const state = buffer();
  if (state.flushing || state.pending.size === 0) return;
  state.flushing = true;

  const batch = [...state.pending.entries()];
  state.pending.clear();

  try {
    const client = await db();
    for (const [mint, observations] of batch) {
      if (observations.length === 0) continue;
      for (const timeframe of STORED_TIMEFRAMES) {
        try {
          await writeCandles(client, mint, timeframe, buildCandles(observations, timeframe));
        } catch (error) {
          console.error('[trades] could not write candles for', mint, error);
        }
      }
    }
  } finally {
    state.flushing = false;
  }
}

export function startTradeCandles(): void {
  const state = buffer();
  if (state.timer) return;
  state.timer = setInterval(() => void flush().catch(() => undefined), FLUSH_INTERVAL_MS);
  // Never the reason the process stays alive.
  state.timer.unref?.();
}

export function stopTradeCandles(): void {
  const state = buffer();
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.pending.clear();
}

/** How many mints are waiting to be written. Reported rather than guessed at. */
export function pendingTradeMints(): number {
  return buffer().pending.size;
}
