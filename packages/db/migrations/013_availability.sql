-- When a dependency was down.
--
-- Intervals, not a log of probes. A probe every ten seconds for a week is sixty
-- thousand rows that answer one question badly; an interval answers it exactly
-- and costs two writes per incident.
--
-- This exists because of the void policy. A season is void if the price feed
-- was unavailable for more than two hours, and a threshold nobody measures is a
-- sentence in a document rather than a rule.

CREATE TABLE outages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dependency    TEXT    NOT NULL CHECK (dependency IN ('rpc','database','feed','coach')),
  started_at    INTEGER NOT NULL,
  -- Null while it is still happening.
  ended_at      INTEGER,
  detail        TEXT
);

-- At most one open outage per dependency. Two processes both noticing the same
-- outage would otherwise open two rows, and the overlap has to be merged on
-- read anyway — better that it cannot happen.
CREATE UNIQUE INDEX outages_open_idx ON outages (dependency) WHERE ended_at IS NULL;

CREATE INDEX outages_window_idx ON outages (started_at, ended_at);
