-- ---------------------------------------------------------------------------
-- what was taken in a token's launch slot
-- ---------------------------------------------------------------------------
-- A pump.fun launch worth screening is usually not one transaction. The creator
-- lands the create and a set of buys together in a single bundle, filled before
-- anybody watching can react, and the result looks like instant volume and is a
-- supply that already belongs to whoever paid for the bundle.
--
-- Stored because unlike every other condition a strategy can screen on, the
-- answer never changes. A token's launch slot is over. So it is read from the
-- chain once per mint, ever, and every strategy that asks afterwards is
-- answered from here for nothing.
--
-- `bundled_bps` is null where the walk could not reach the create inside its
-- bound. That is deliberately a stored null rather than an absent row: the
-- difference between "nobody has looked" and "somebody looked and could not
-- tell" is the difference between trying again and not, and a token that costs
-- a hundred credits to fail on should only fail once.
CREATE TABLE launch_bundles (
  mint         TEXT PRIMARY KEY,
  -- The slot the create landed in.
  slot         INTEGER,
  -- Tokens bought in that slot, in base units, as a digit string like every
  -- other amount in this schema.
  bought       TEXT,
  -- That as a share of supply. Null means it could not be determined.
  bundled_bps  INTEGER,
  -- How many buys landed in the launch slot. One is an ordinary dev buy.
  buys         INTEGER,
  read_at      INTEGER NOT NULL
);
