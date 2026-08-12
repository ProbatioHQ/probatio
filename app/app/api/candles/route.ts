import { readCandles } from '@probatio/db';
import { TIMEFRAMES, timeframeSeconds, type Timeframe } from '@probatio/candles';
import { PUMPFUN_TOKEN_DECIMALS, PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { backfillChart, backfillInFlight } from '@/lib/chart-backfill';
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

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const mint = url.searchParams.get('mint');
  const timeframe = (url.searchParams.get('timeframe') ?? 'm1') as Timeframe;
  const limitParam = Number(url.searchParams.get('limit') ?? '300');

  if (!mint || !MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint address is required' }, { status: 400 });
  }
  if (!(timeframe in TIMEFRAMES)) {
    return Response.json(
      { error: `unknown timeframe, expected one of ${Object.keys(TIMEFRAMES).join(', ')}` },
      { status: 400 },
    );
  }

  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(Math.trunc(limitParam), 1), MAX_CANDLES)
    : 300;

  const candles = await readCandles(await db(), mint, timeframe, limit);

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
    candles: withoutGaps(
      candles.map((candle) => ({
        time: candle.openTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        trades: candle.trades,
      })),
      timeframeSeconds(timeframe),
    ),
  });
}

interface WireCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

/**
 * A continuous line, not a scatter of dashes.
 *
 * A candle is only stored for a bucket that saw a trade, so a token that trades
 * in bursts leaves empty buckets between them and the chart drew each survivor
 * floating on its own with gaps in between. A market does not disappear because
 * nobody traded for a minute; it stays where it was. So every empty bucket
 * between two real ones is filled with a flat candle at the last price, exactly
 * as every other charting tool does it, and the line becomes continuous.
 *
 * Bounded, because a token with an hour between two trades would otherwise
 * generate an hour of one-second candles. Past the cap the gap is left as a gap
 * rather than blowing up the response.
 */
const MAX_FILLED = 2_000;

function withoutGaps(candles: WireCandle[], size: number): WireCandle[] {
  if (candles.length < 2 || size <= 0) return candles;

  const filled: WireCandle[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i]!;
    filled.push(candle);

    const next = candles[i + 1];
    if (!next) break;

    for (
      let time = candle.time + size;
      time < next.time && filled.length < MAX_FILLED;
      time += size
    ) {
      filled.push({
        time,
        open: candle.close,
        high: candle.close,
        low: candle.close,
        close: candle.close,
        volume: '0',
        trades: 0,
      });
    }
  }
  return filled;
}
