-- The pool as it stood immediately after each observed swap.
--
-- Without these, a copy of somebody else's trade can only be priced at the
-- price they got, which is the lie every copy trading product tells. You do not
-- get their price. You arrive after them, into a pool their own order has
-- already moved, and the gap between those two numbers is the single reason
-- most people lose money following a profitable wallet.
--
-- These are the reserves that gap is computed from. The walk already decodes
-- them to build the candles, so keeping them costs two columns and nothing else.
--
-- Nullable, because rows written before this migration do not have them and a
-- swap without reserves is still a swap worth counting on the trader board. The
-- backtest skips what it cannot price rather than guessing.
ALTER TABLE observed_swaps ADD COLUMN sol_after TEXT;
ALTER TABLE observed_swaps ADD COLUMN token_after TEXT;
