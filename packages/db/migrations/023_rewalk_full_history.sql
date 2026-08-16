-- Re-walk every token's history at the new, deeper depth.
--
-- The previous walk reached only the most recent couple of thousand swaps, so a
-- heavily traded token's chart had a flat gap where the middle of its life
-- should be. The walk is deeper now, but a token already recorded as backfilled
-- would never re-walk. Clearing the candles and the walk records forces a clean
-- rebuild on next view, at the new depth, without the volume double-counting
-- that re-walking on top of old candles would cause. All re-derivable from
-- chain; nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
