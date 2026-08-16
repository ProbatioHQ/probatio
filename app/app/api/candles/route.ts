import { readCandles, rollupCandles, type StoredCandle } from '@probatio/db';
import { TIMEFRAMES, timeframeSeconds, type Timeframe } from '@probatio/candles';
import { PUMPFUN_TOKEN_DECIMALS, PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { backfillChart, backfillInFlight } from '@/lib/chart-backfill';
import { continuous } from '@/lib/continuous-candles';
import { noteViewed } from '@/lib/watched';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Candles for a chart.
 *
 * Prices go over the wire as the exact scaled integers they are stored as,
 * rather than as JSON numbers. A double cannot hold a price scaled by 1e18, so
 * serializing one here would round the value before the client ever saw it —
 * and the client is the only place that is allowed to lose precision, at the
 * moment it hands a number to a charting library.
 */

const MAX_CANDLES = 1_000;
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const HOUR = 3_600;
/**
 * The long timeframes, in seconds, each a whole number of hours.
 *
 * Built from the stored hourly candle rather than written on every poll: an old
 * token needs a day or a week per candle to show its whole life on one screen,
 * and those buckets move too slowly to be worth a write every few seconds.
 */
const DERIVED_SECONDS: Record<string, number> = {
  h4: 4 * HOUR,
  h12: 12 * HOUR,
  d1: 24 * HOUR,
  w1: 7 * 24 * HOUR,
  mo1: 30 * 24 * HOUR,
};

/** The most hourly candles read to build a coarse one: about a year of them. */
const MAX_HOURLY = 10_000;

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const mint = url.searchParams.get('mint');
  const timeframe = url.searchParams.get('timeframe') ?? 'm1';
  const limitParam = Number(url.searchParams.get('limit') ?? '300');

  if (!mint || !MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint address is required' }, { status: 400 });
  }

  const stored = timeframe in TIMEFRAMES;
  const derivedSeconds = DERIVED_SECONDS[timeframe];
  if (!stored && derivedSeconds === undefined) {
    const known = [...Object.keys(TIMEFRAMES), ...Object.keys(DERIVED_SECONDS)].join(', ');
    return Response.json({ error: `unknown timeframe, expected one of ${known}` }, { status: 400 });
  }
  const seconds = stored ? timeframeSeconds(timeframe as Timeframe) : derivedSeconds!;

  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_CANDLES)
    : 300;

  const client = await db();
  let candles: StoredCandle[];
  if (stored) {
    candles = await readCandles(client, mint, timeframe, limit);
  } else {
    // Built from the hourly candle: read enough hours to cover the coarse
    // buckets asked for, then roll them up and keep the most recent `limit`.
    const perBucket = Math.round(derivedSeconds! / HOUR);
    const hourly = await readCandles(client, mint, 'h1', Math.min(limit * perBucket, MAX_HOURLY));
    candles = rollupCandles(hourly, derivedSeconds!).slice(-limit);
  }

  /*
   * Ask for this token's history. Kicked off in the background: the walk takes
   * seconds and the caller is not made to wait for it.
   *
   * Unconditional, because `backfillChart` already decides whether there is
   * anything to do — it is recorded per mint, capped, and limited to two at a
   * time. This used to be guarded by `candles.length < 5`, and that guard was
   * the reason charts looked empty. A token the feed had watched for a few
   * minutes had ten candles, which is more than five, so it never qualified for
   * a backfill and stayed at ten candles for the life of the database. Ten
   * points is enough to pass a "has data" test and nowhere near enough to draw
   * a chart, so the tokens that looked worst were the exact ones the check
   * decided were fine.
   */
  backfillChart(mint);

  // Asking for this chart is what makes the token worth pricing often. The
  // watcher rotates a fixed budget across the whole feed, which leaves a
  // graduated token minutes between reads — fine for a lane of dashes, useless
  // for the chart somebody is actually watching.
  noteViewed(mint);

  return Response.json({
    mint,
    timeframe,
    // So the client can say "reading its history" rather than "never traded",
    // which were the same message before and only one of them was true.
    backfilling: backfillInFlight(mint),
    // pump.fun mints a fixed supply, which is what turns a price into the
    // market cap figure traders actually read.
    tokenDecimals: PUMPFUN_TOKEN_DECIMALS,
    totalSupply: PUMPFUN_TOKEN_TOTAL_SUPPLY.toString(),
    candles: continuous(
      candles.map((candle) => ({
        time: candle.openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        trades: candle.trades,
      })),
      seconds,
    ),
  });
}
