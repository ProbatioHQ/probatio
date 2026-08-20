-- Real pump.fun trades, by the wallet that made them.
--
-- These are not Probatio fills. They are somebody else's actual swaps, read off
-- the chain during the pool walk this site already does to draw a chart, and
-- kept because the walk was throwing away the one field that says who traded.
--
-- Nothing here is derived from a Probatio account and nothing here can affect
-- one. It exists so a board of real traders can be built from work already
-- being paid for, rather than from a data vendor who can switch it off.
--
-- The signature is the key. A pool gets walked again whenever its chart is
-- refreshed, so the same swap arrives repeatedly, and an insert that is not
-- idempotent would count one trade as ten.
CREATE TABLE observed_swaps (
  signature   TEXT    PRIMARY KEY,
  trader      TEXT    NOT NULL,
  mint        TEXT    NOT NULL,
  is_buy      INTEGER NOT NULL CHECK (is_buy IN (0, 1)),

  -- Lamports in on a buy, lamports out on a sell, both already net of the fees
  -- the swap paid. Stored as text like every other amount here, because these
  -- are exact integers and a float would quietly round somebody's record.
  sol_amount  TEXT    NOT NULL,
  token_amount TEXT   NOT NULL,

  slot        INTEGER NOT NULL,
  -- Unix seconds from the block. Null when the node did not carry one, which
  -- happens on older transactions and is not a reason to drop the swap.
  block_time  INTEGER,
  seen_at     INTEGER NOT NULL
);

-- The board: everything one wallet did, newest first.
CREATE INDEX observed_swaps_by_trader ON observed_swaps (trader, block_time DESC);

-- Pairing buys against sells to work out what a wallet actually made on a
-- token, which is per trader and per mint rather than across the whole table.
CREATE INDEX observed_swaps_by_trader_mint ON observed_swaps (trader, mint);

-- Retention prunes by age, and this is the column it reads.
CREATE INDEX observed_swaps_by_time ON observed_swaps (block_time);
