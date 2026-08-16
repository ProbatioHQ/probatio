-- Re-walk every token again, now deep enough to reach launch.
--
-- The previous depth reached a heavily traded token's most recent week but
-- stopped a day or two short of its first trade, leaving the very start of the
-- chart missing. The walk is deeper again; clearing the candles and walk records
-- forces already-walked tokens to re-derive from launch on next view, without
-- the volume double-counting a walk over existing candles would cause. All
-- re-derivable from chain; nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
