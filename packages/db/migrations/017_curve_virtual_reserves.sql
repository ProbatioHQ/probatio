-- The reserves a price actually comes from.
--
-- 016 stored the real reserves, which answer "how far along the curve is". They
-- do not answer "what is this worth" — that comes from the virtual reserves,
-- which is what the fill engine quotes against and what every price in this
-- system is derived from. Storing them here means the feed can show a market
-- cap without a second read of the same account.
--
-- Nullable rather than defaulted. A row written by 016 genuinely does not know
-- these, and a zero would be a price of zero rather than an absent one.

ALTER TABLE curve_state ADD COLUMN virtual_sol_reserves   TEXT;
ALTER TABLE curve_state ADD COLUMN virtual_token_reserves TEXT;
