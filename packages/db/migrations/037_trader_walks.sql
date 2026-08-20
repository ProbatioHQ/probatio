-- Which wallets have had their own history read, and when.
--
-- Pool walks discover wallets; they cannot score them. Six hundred recent swaps
-- of a busy pool cover about half an hour, so a wallet's buy and its sell are
-- almost never both in the slice, and fifteen hundred wallets were read here
-- with five of them scoreable. Reading a wallet's own signatures is the walk
-- that produces round trips, and it is expensive enough that it must not be
-- repeated for a wallet already done.
CREATE TABLE trader_walks (
  trader     TEXT PRIMARY KEY,
  -- Unix milliseconds of the last walk, so a stale wallet can be refreshed.
  walked_at  INTEGER NOT NULL,
  -- What the walk found, kept for the log rather than for any query.
  swaps      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX trader_walks_by_time ON trader_walks (walked_at);
