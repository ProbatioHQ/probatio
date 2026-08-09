-- The launch feed.
--
-- One row per pump.fun token creation, taken from the CreateEvent the program
-- emits. Chain-native rather than scraped: pump.fun has no official API, and
-- the community endpoints are undocumented and can change without notice.
--
-- Discovery is allowed to be incomplete in a way execution is not. If a launch
-- is missed the feed is briefly short of one token, which nobody can tell; if a
-- price were missed the fill would be wrong, which is the whole product. That
-- asymmetry is why this table is fed by a stream that may drop, while prices
-- are always read from chain at the moment of the trade.

CREATE TABLE launches (
  mint            TEXT PRIMARY KEY,
  bonding_curve   TEXT    NOT NULL,
  creator         TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  symbol          TEXT    NOT NULL,
  uri             TEXT    NOT NULL,
  -- Unix seconds, from the event itself rather than from our clock.
  launched_at     INTEGER NOT NULL,
  slot            INTEGER,
  -- When we first saw it, which can lag the launch if the stream reconnects.
  first_seen_at   INTEGER NOT NULL,
  CHECK (launched_at > 1600000000)
);

-- The feed's only ordering: newest first.
CREATE INDEX launches_recent_idx ON launches (launched_at DESC);

-- Searching by what a person actually types.
CREATE INDEX launches_symbol_idx ON launches (symbol);
CREATE INDEX launches_creator_idx ON launches (creator, launched_at DESC);
