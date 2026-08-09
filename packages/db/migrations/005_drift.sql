-- Drift observations.
--
-- The record of whether the simulator still agrees with the chain. Kept as
-- history rather than a single current value, because the question that
-- matters after an incident is "when did this start" — and a gauge showing
-- only the present cannot answer it.
--
-- `median_signed_bps` is the important column and it is signed on purpose. A
-- negative value means the engine filled worse than reality: a bug, unfair,
-- harmless to the leaderboard. A positive value means it filled better, which
-- is farmable, and is the reason this table exists at all.

CREATE TABLE drift_observations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mint              TEXT    NOT NULL,
  engine_version    INTEGER NOT NULL,
  samples           INTEGER NOT NULL CHECK (samples >= 0),
  median_signed_bps INTEGER NOT NULL,
  median_abs_bps    INTEGER NOT NULL CHECK (median_abs_bps >= 0),
  generous_samples  INTEGER NOT NULL CHECK (generous_samples >= 0),
  severity          TEXT    NOT NULL CHECK (severity IN ('ok','watch','divergent','exploitable')),
  observed_at       INTEGER NOT NULL
);

CREATE INDEX drift_recent_idx ON drift_observations (mint, observed_at DESC);
CREATE INDEX drift_severity_idx ON drift_observations (severity, observed_at DESC);


-- Tokens currently barred from ranked trading.
--
-- A token where the simulator is generous has to stop counting immediately,
-- before it is investigated — leaving it live while someone looks into it is
-- how a whole season's results become worthless. Lifting a suspension is
-- deliberate and recorded rather than automatic, because the engine agreeing
-- again does not undo the trades made while it did not.

CREATE TABLE suspended_tokens (
  mint         TEXT    PRIMARY KEY,
  reason       TEXT    NOT NULL,
  severity     TEXT    NOT NULL,
  suspended_at INTEGER NOT NULL,
  lifted_at    INTEGER,
  lifted_note  TEXT
);

CREATE INDEX suspended_active_idx ON suspended_tokens (lifted_at);
