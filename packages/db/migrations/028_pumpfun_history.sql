-- Re-derive charts from pump.fun's own candle service.
--
-- History now comes from pump.fun's candle service, which serves OHLC at every
-- interval from launch — the exact series their chart draws — so the native
-- chart matches it one to one at every timeframe. h4/h12/d1 are stored in their
-- own right from it (not rolled up from hourly, which stops short for an old
-- token). Clearing candles and walk records forces the clean rebuild. All
-- re-derivable; nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
