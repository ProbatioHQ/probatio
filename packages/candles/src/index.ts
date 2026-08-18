/**
 * @probatio/candles — OHLCV aggregation and historical reconstruction.
 *
 * Every price in this package derives from pool reserves, which is the same
 * source the fill engine quotes against. A chart and a fill therefore cannot
 * disagree — which matters more here than in an ordinary trading app, because
 * the product's whole claim is that its fills are honest.
 */

export { PRICE_SCALE, PriceError, marketCapLamports, priceFromReserves, priceToNumber } from './price';
export type { ScaledPrice } from './price';

export {
  CandleError,
  STORED_TIMEFRAMES,
  TIMEFRAMES,
  bucketStart,
  buildCandles,
  fillGaps,
  mergeCandles,
  timeframeSeconds,
} from './candles';
export type { Candle, Observation, Timeframe } from './candles';

export { backfillFromCurve, observationFromEvent } from './backfill';
export type { BackfillOptions, BackfillResult } from './backfill';
