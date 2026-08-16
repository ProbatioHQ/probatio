-- Re-derive charts after retention changed from ageing to counting.
--
-- Retention used to drop candles by age, on windows too short for the fine
-- timeframes to reach launch (and with no window at all for h4/h12/d1, which the
-- default would have deleted after three days). It now keeps the most recent
-- ~1,200 of each timeframe instead, so a chart's whole history survives. Some of
-- that history was already aged out; clearing candles and walk records forces a
-- clean rebuild from pump.fun's service. Re-derivable; nothing a person entered
-- is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
