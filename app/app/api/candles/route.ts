import { readCandles } from '@probatio/db';
import { TIMEFRAMES, type Timeframe } from '@probatio/candles';
import { PUMPFUN_TOKEN_DECIMALS, PUMPFUN_TOKEN_TOTAL_SUPPLY } from '@probatio/pools';
import { backfillChart, backfillInFlight } from '@/lib/chart-backfill';
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

  // A chart with almost nothing on it means nobody has read this token's
  // history yet, not that it has never traded. Kicked off in the background:
  // the walk takes seconds and the caller is not made to wait for it.
  if (candles.length < 5) backfillChart(mint);

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
    candles: candles.map((candle) => ({
      time: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      trades: candle.trades,
    })),
  });
}
