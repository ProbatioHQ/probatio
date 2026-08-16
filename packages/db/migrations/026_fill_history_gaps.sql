-- Re-derive charts so the index fills every gap the walk left, not just the tail.
--
-- The first splice only filled buckets older than the walk's oldest candle, so a
-- lone bonding-curve candle sitting at launch left the days between it and the
-- pool walk empty. The splice now fills any bucket the walk did not produce.
-- Clearing candles and walk records forces the clean rebuild. Re-derivable;
-- nothing a person entered is touched.
DELETE FROM candles;
DELETE FROM candle_backfills;
