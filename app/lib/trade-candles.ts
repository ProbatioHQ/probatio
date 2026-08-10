import 'server-only';
import { TIMEFRAMES, buildCandles, observationFromEvent, type Observation, type Timeframe } from '@probatio/candles';
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

const pending = new Map<string, Observation[]>();
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

export function ingestTradeEvents(events: readonly TradeEvent[]): void {
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
  if (flushing || pending.size === 0) return;
  flushing = true;

  const batch = [...pending.entries()];
  pending.clear();

  try {
    const client = await db();
    for (const [mint, observations] of batch) {
      if (observations.length === 0) continue;
      for (const timeframe of Object.keys(TIMEFRAMES) as Timeframe[]) {
        try {
          await writeCandles(client, mint, timeframe, buildCandles(observations, timeframe));
        } catch (error) {
          console.error('[trades] could not write candles for', mint, error);
        }
      }
    }
  } finally {
    flushing = false;
  }
}

export function startTradeCandles(): void {
  if (timer) return;
  timer = setInterval(() => void flush().catch(() => undefined), FLUSH_INTERVAL_MS);
  // Never the reason the process stays alive.
  timer.unref?.();
}

export function stopTradeCandles(): void {
  if (timer) clearInterval(timer);
  timer = null;
  pending.clear();
}

/** How many mints are waiting to be written. Reported rather than guessed at. */
export function pendingTradeMints(): number {
  return pending.size;
}
