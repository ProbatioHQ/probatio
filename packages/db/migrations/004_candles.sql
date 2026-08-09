-- OHLCV candles.
--
-- Prices are stored as digit strings for the same reason every amount is: they
-- are fixed-point integers scaled by 1e18, and a REAL column would quietly
-- round the one number the whole chart is made of.
--
-- One row per (mint, timeframe, open_time). The most recent row for a mint is
-- normally still open — more trades will land in the same bucket — so writes
-- merge rather than replace: the open is kept, the close is overwritten, the
-- high and low widen, and volume accumulates.

CREATE TABLE candles (
  mint         TEXT    NOT NULL,
  timeframe    TEXT    NOT NULL,
  open_time    INTEGER NOT NULL,

  open         TEXT    NOT NULL CHECK (open NOT GLOB '*[^0-9]*' AND length(open) > 0),
  high         TEXT    NOT NULL CHECK (high NOT GLOB '*[^0-9]*' AND length(high) > 0),
  low          TEXT    NOT NULL CHECK (low NOT GLOB '*[^0-9]*' AND length(low) > 0),
  close        TEXT    NOT NULL CHECK (close NOT GLOB '*[^0-9]*' AND length(close) > 0),
  volume       TEXT    NOT NULL CHECK (volume NOT GLOB '*[^0-9]*' AND length(volume) > 0),
  trades       INTEGER NOT NULL CHECK (trades >= 0),

  PRIMARY KEY (mint, timeframe, open_time)
);

-- The read every chart makes: one mint, one timeframe, the most recent window.
CREATE INDEX candles_recent_idx ON candles (mint, timeframe, open_time DESC);


-- How far back each token's history has been reconstructed.
--
-- Backfill is expensive — a token with thousands of trades is thousands of RPC
-- calls — so it is done once per token and recorded. `truncated` marks the
-- difference between "this is all the history there is" and "this is as far as
-- we were willing to pay to go", which a chart needs in order to avoid claiming
-- a token launched at the oldest candle it happens to hold.

CREATE TABLE candle_backfills (
  mint             TEXT    PRIMARY KEY,
  oldest_timestamp INTEGER,
  newest_timestamp INTEGER,
  observations     INTEGER NOT NULL DEFAULT 0,
  truncated        INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  completed_at     INTEGER NOT NULL
);
