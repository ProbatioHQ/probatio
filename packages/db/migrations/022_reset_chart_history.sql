-- Reset chart data so every token redraws its whole history from launch.
--
-- The backfill used to chart a graduated token from its pool alone, hiding
-- everything before it graduated — for a token days old, most of its life. It
-- now writes the bonding-curve history and the pool history together, so the
-- chart runs from the first trade.
--
-- Existing tokens were already recorded as backfilled (pool only), so they
-- would never re-walk; and re-walking on top of their existing candles would
-- double their volume, because candle writes accumulate. Clearing both the
-- candles and the walk records forces a clean rebuild on next view instead.
-- All of this is re-derivable from chain; nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
