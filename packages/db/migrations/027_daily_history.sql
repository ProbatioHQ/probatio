-- Re-derive charts so the day/week/month views reach launch.
--
-- Old, quiet tokens have no hourly candles from their first months — only daily
-- ones — and a graduated token's launch history lives on its bonding-curve pool,
-- not the deep pool a chart follows now. The index splice now pulls the daily
-- series from every pool and stores it as its own d1 timeframe, which the coarse
-- views read. Clearing candles and walk records forces the clean rebuild. All
-- re-derivable; nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
