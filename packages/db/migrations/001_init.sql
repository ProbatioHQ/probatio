-- Probatio initial schema.
--
-- Two conventions run through every table here, and both exist because they
-- cannot be introduced later without invalidating every record written before
-- the change.
--
-- AMOUNTS ARE TEXT. Every monetary value is stored as the decimal string of an
-- integer in the asset's smallest unit — lamports for SOL, base units for SPL
-- tokens. Not REAL, and not INTEGER. Not REAL because floating point drift is
-- exactly what this project claims cannot happen. Not INTEGER because SQLite
-- caps at signed 64-bit, and a high-supply token with 9 decimals can exceed it.
-- No arithmetic is ever performed in SQL; every calculation happens in
-- @probatio/sim on bigints. This database stores, it does not compute.
--
-- TRADES ARE APPEND-ONLY. Enforced below by triggers, not by convention. A
-- trade row is never updated and never deleted. Anything that looks like a
-- correction is a new row. If a trade could be edited after the fact, the
-- on-chain commitments would be decoration.

PRAGMA foreign_keys = ON;

-- A digit-only string, with no leading zeros unless the value is exactly zero.
-- Applied to every amount column so a malformed write fails loudly at insert
-- rather than quietly poisoning a balance.
--
-- (SQLite has no reusable domain types, so the constraint is repeated inline.)


-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- A user is a wallet. There is no email column, no password column, and no
-- alternate identifier. This is deliberate and permanent: the moment a second
-- way to be a user exists, someone builds against it and the pubkey stops
-- being the primary key of the system.

CREATE TABLE users (
  pubkey        TEXT PRIMARY KEY,
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  CHECK (length(pubkey) BETWEEN 32 AND 44)
);


-- ---------------------------------------------------------------------------
-- seasons
-- ---------------------------------------------------------------------------
-- Every parameter that could change a result is recorded on the season row and
-- committed on chain. Not just the trades — the conditions. Without this,
-- someone can claim the rules moved mid-season and there is no answer.
--
-- ordinal -1 is reserved for free play, which is unranked, has no entry cost
-- and no end date. Modelling it as a season keeps every downstream query
-- uniform instead of forking on "is this ranked".

CREATE TABLE seasons (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ordinal               INTEGER NOT NULL UNIQUE,
  name                  TEXT    NOT NULL,
  ranked                INTEGER NOT NULL CHECK (ranked IN (0, 1)),
  status                TEXT    NOT NULL CHECK (status IN ('pending','entry_open','running','closed','finalized')),

  starts_at             INTEGER,
  ends_at               INTEGER,
  entry_opens_at        INTEGER,
  entry_closes_at       INTEGER,

  -- A1 spec: 10 SOL sim balance, 0.05 SOL entry.
  starting_balance      TEXT    NOT NULL CHECK (starting_balance = '0' OR (length(starting_balance) > 0 AND starting_balance NOT GLOB '*[^0-9]*' AND starting_balance NOT GLOB '0*')),
  entry_cost            TEXT    NOT NULL CHECK (entry_cost = '0' OR (length(entry_cost) > 0 AND entry_cost NOT GLOB '*[^0-9]*' AND entry_cost NOT GLOB '0*')),

  -- A1 spec: 30 closed trades across at least 20 distinct tokens.
  min_trades            INTEGER NOT NULL,
  min_distinct_tokens   INTEGER NOT NULL,

  -- A1 spec: 10% house, but only once the pot exceeds house_threshold.
  house_bps             INTEGER NOT NULL CHECK (house_bps BETWEEN 0 AND 10000),
  house_threshold       TEXT    NOT NULL CHECK (house_threshold = '0' OR (length(house_threshold) > 0 AND house_threshold NOT GLOB '*[^0-9]*' AND house_threshold NOT GLOB '0*')),

  -- Simulation conditions. These are what make a result reproducible.
  latency_ms            INTEGER NOT NULL,
  max_price_impact_bps  INTEGER NOT NULL,
  engine_version        INTEGER NOT NULL,
  scoring_formula_hash  TEXT    NOT NULL,

  -- Set once the season exists on chain.
  onchain_pubkey        TEXT,
  finalized_at          INTEGER,

  created_at            INTEGER NOT NULL
);

CREATE INDEX seasons_status_idx ON seasons (status);


-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- A simulated balance for one user in one season.
--
-- `generation` exists because free play resets on demand. A reset creates a new
-- generation rather than clearing anything, so the trades from before it stay
-- exactly where they are. Nothing in this system is ever erased.

CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL REFERENCES seasons (id),
  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),
  generation    INTEGER NOT NULL DEFAULT 0,
  sol_balance   TEXT    NOT NULL CHECK (sol_balance = '0' OR (length(sol_balance) > 0 AND sol_balance NOT GLOB '*[^0-9]*' AND sol_balance NOT GLOB '0*')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (season_id, user_pubkey, generation)
);

CREATE INDEX accounts_user_idx ON accounts (user_pubkey);


-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
-- Every payment is a Solana transaction the user signed in their wallet. The
-- signature is unique, so a transaction can never be credited twice, and
-- `status` is only moved to 'verified' after the transaction has been confirmed
-- on chain rather than when the client claims it succeeded.

CREATE TABLE payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),
  season_id     INTEGER REFERENCES seasons (id),
  purpose       TEXT    NOT NULL CHECK (purpose IN ('season_entry','coach_upgrade')),
  amount        TEXT    NOT NULL CHECK (amount = '0' OR (length(amount) > 0 AND amount NOT GLOB '*[^0-9]*' AND amount NOT GLOB '0*')),
  tx_signature  TEXT    NOT NULL UNIQUE,
  status        TEXT    NOT NULL CHECK (status IN ('pending','verified','failed')),
  created_at    INTEGER NOT NULL,
  verified_at   INTEGER
);

CREATE INDEX payments_user_idx ON payments (user_pubkey, season_id);


-- ---------------------------------------------------------------------------
-- entries
-- ---------------------------------------------------------------------------
-- A user's registration in a ranked season, and their result once it closes.
--
-- percentile, trade_count and distinct_token_count are carried here for block P.
-- Capital allocation eventually asks "three ranked seasons finishing top 10%
-- with trade minimums met" — a question that can only be answered if it was
-- being recorded from the very first season. It is not needed for years. It is
-- stored from day one anyway.

CREATE TABLE entries (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id             INTEGER NOT NULL REFERENCES seasons (id),
  user_pubkey           TEXT    NOT NULL REFERENCES users (pubkey),
  payment_id            INTEGER REFERENCES payments (id),
  entered_at            INTEGER NOT NULL,

  qualified             INTEGER CHECK (qualified IN (0, 1)),
  trade_count           INTEGER,
  distinct_token_count  INTEGER,
  score                 TEXT,
  rank                  INTEGER,
  percentile            REAL,
  payout                TEXT CHECK (payout IS NULL OR payout = '0' OR (length(payout) > 0 AND payout NOT GLOB '*[^0-9]*' AND payout NOT GLOB '0*')),
  payout_tx_signature   TEXT,

  UNIQUE (season_id, user_pubkey)
);

CREATE INDEX entries_season_rank_idx ON entries (season_id, rank);


-- ---------------------------------------------------------------------------
-- pool_snapshots
-- ---------------------------------------------------------------------------
-- The reserve state a fill was quoted against, kept so any trade can be
-- recomputed from the same inputs the engine saw. This is what makes step 11's
-- replay possible after the fact rather than only at the time.

CREATE TABLE pool_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  mint            TEXT    NOT NULL,
  sol_reserve     TEXT    NOT NULL CHECK (sol_reserve = '0' OR (length(sol_reserve) > 0 AND sol_reserve NOT GLOB '*[^0-9]*' AND sol_reserve NOT GLOB '0*')),
  token_reserve   TEXT    NOT NULL CHECK (token_reserve = '0' OR (length(token_reserve) > 0 AND token_reserve NOT GLOB '*[^0-9]*' AND token_reserve NOT GLOB '0*')),
  token_decimals  INTEGER NOT NULL,
  fee_bps         INTEGER NOT NULL,
  source          TEXT    NOT NULL CHECK (source IN ('pumpfun-curve','pumpswap','raydium')),
  slot            INTEGER NOT NULL,
  observed_at     INTEGER NOT NULL,
  UNIQUE (mint, slot)
);

CREATE INDEX pool_snapshots_mint_slot_idx ON pool_snapshots (mint, slot DESC);


-- ---------------------------------------------------------------------------
-- trades
-- ---------------------------------------------------------------------------
-- Append-only. See the triggers below.
--
-- engine_version is stored per trade rather than only per season because an
-- engine change can land mid-season, and a leaf has to stay checkable against
-- the rules that were in force at the moment it was written.
--
-- There is deliberately no commit_id column. Batching a trade into a merkle
-- root would mean updating the row, and trades cannot be updated — so commits
-- reference trades by range instead.

CREATE TABLE trades (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES accounts (id),
  season_id           INTEGER NOT NULL REFERENCES seasons (id),
  user_pubkey         TEXT    NOT NULL REFERENCES users (pubkey),

  mint                TEXT    NOT NULL,
  side                TEXT    NOT NULL CHECK (side IN ('buy','sell')),
  sol_amount          TEXT    NOT NULL CHECK (sol_amount = '0' OR (length(sol_amount) > 0 AND sol_amount NOT GLOB '*[^0-9]*' AND sol_amount NOT GLOB '0*')),
  token_amount        TEXT    NOT NULL CHECK (token_amount = '0' OR (length(token_amount) > 0 AND token_amount NOT GLOB '*[^0-9]*' AND token_amount NOT GLOB '0*')),
  fee                 TEXT    NOT NULL CHECK (fee = '0' OR (length(fee) > 0 AND fee NOT GLOB '*[^0-9]*' AND fee NOT GLOB '0*')),

  -- How the fill was produced.
  price_impact_bps    INTEGER NOT NULL,
  partial             INTEGER NOT NULL CHECK (partial IN (0, 1)),
  pool_source         TEXT    NOT NULL CHECK (pool_source IN ('pumpfun-curve','pumpswap','raydium')),
  clicked_at_slot     INTEGER NOT NULL,
  filled_at_slot      INTEGER NOT NULL,
  latency_ms          INTEGER NOT NULL,
  engine_version      INTEGER NOT NULL,
  pool_snapshot_id    INTEGER NOT NULL REFERENCES pool_snapshots (id),

  -- The canonical hash of this trade, computed at insert. This is the merkle
  -- leaf.
  leaf_hash           TEXT    NOT NULL,

  created_at          INTEGER NOT NULL,

  CHECK (filled_at_slot >= clicked_at_slot)
);

CREATE INDEX trades_account_idx ON trades (account_id, id);
CREATE INDEX trades_season_user_idx ON trades (season_id, user_pubkey, id);
CREATE INDEX trades_mint_idx ON trades (mint);

CREATE TRIGGER trades_are_append_only_update
BEFORE UPDATE ON trades
BEGIN
  SELECT RAISE(ABORT, 'trades are append-only: a trade cannot be updated');
END;

CREATE TRIGGER trades_are_append_only_delete
BEFORE DELETE ON trades
BEGIN
  SELECT RAISE(ABORT, 'trades are append-only: a trade cannot be deleted');
END;


-- ---------------------------------------------------------------------------
-- positions
-- ---------------------------------------------------------------------------
-- A projection of the trade log, kept materialised so the app does not replay
-- every trade to draw a positions panel. Mutable on purpose: it holds no
-- authority, and can be dropped and rebuilt from `trades` at any time.

CREATE TABLE positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL REFERENCES accounts (id),
  mint            TEXT    NOT NULL,
  token_amount    TEXT    NOT NULL CHECK (token_amount = '0' OR (length(token_amount) > 0 AND token_amount NOT GLOB '*[^0-9]*' AND token_amount NOT GLOB '0*')),
  cost_basis      TEXT    NOT NULL CHECK (cost_basis = '0' OR (length(cost_basis) > 0 AND cost_basis NOT GLOB '*[^0-9]*' AND cost_basis NOT GLOB '0*')),
  -- The one column allowed to be negative, so it gets its own constraint
  -- rather than borrowing the unsigned one.
  realized_pnl    TEXT    NOT NULL CHECK (
                    realized_pnl = '0'
                    OR (realized_pnl GLOB '[1-9]*' AND realized_pnl NOT GLOB '*[^0-9]*')
                    OR (realized_pnl GLOB '-[1-9]*' AND substr(realized_pnl, 2) NOT GLOB '*[^0-9]*')
                  ),
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER,
  updated_at      INTEGER NOT NULL,
  UNIQUE (account_id, mint, opened_at)
);

CREATE INDEX positions_open_idx ON positions (account_id, closed_at);


-- ---------------------------------------------------------------------------
-- commits
-- ---------------------------------------------------------------------------
-- One merkle root covering a contiguous range of one user's trades in one
-- season. Many rows share a tx_signature, because roots are batched into a
-- single transaction to keep the fee negligible even when the free tier is
-- most of the userbase.

CREATE TABLE commits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id       INTEGER NOT NULL REFERENCES seasons (id),
  user_pubkey     TEXT    NOT NULL REFERENCES users (pubkey),
  merkle_root     TEXT    NOT NULL,
  leaf_count      INTEGER NOT NULL CHECK (leaf_count > 0),
  from_trade_id   INTEGER NOT NULL REFERENCES trades (id),
  to_trade_id     INTEGER NOT NULL REFERENCES trades (id),
  engine_version  INTEGER NOT NULL,
  tx_signature    TEXT,
  slot            INTEGER,
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  CHECK (to_trade_id >= from_trade_id)
);

CREATE INDEX commits_season_user_idx ON commits (season_id, user_pubkey, from_trade_id);
CREATE INDEX commits_unconfirmed_idx ON commits (confirmed_at) WHERE confirmed_at IS NULL;


-- ---------------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------------
-- Coach output. `metrics_json` holds the deterministic figures the analytics
-- engine computed; `body` holds what the model wrote about them. Keeping both
-- means a report can be audited against its own inputs, and that the metrics
-- survive even if the wording is regenerated.

CREATE TABLE reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),
  account_id    INTEGER REFERENCES accounts (id),
  season_id     INTEGER REFERENCES seasons (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('session','weekly','season')),
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  metrics_json  TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX reports_user_idx ON reports (user_pubkey, created_at DESC);
