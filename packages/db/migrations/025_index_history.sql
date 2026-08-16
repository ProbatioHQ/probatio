-- Re-derive every token's chart with the index splice in place.
--
-- Deep history now comes from an index (GeckoTerminal), which has a token's
-- OHLCV from launch, rather than from walking tens of thousands of trades that
-- still stopped short of the first day. Clearing the candles and walk records
-- forces a clean rebuild on next view: a shorter on-chain walk for the recent
-- end at the live price's scale, and the index for everything before it. All
-- re-derivable; nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
