-- ---------------------------------------------------------------------------
-- Automated strategies, and the keys that let a program place orders.
-- ---------------------------------------------------------------------------
--
-- Two ways to trade without clicking, and they are deliberately the same thing
-- underneath: both end at `executeTrade`, both take the season's latency, both
-- are quoted against a pool read twice, and both write an ordinary trade row.
-- There is no faster lane and no separate table of bot trades, because a record
-- that ranks beside a person's has to have been made the same way.
--
--   strategies    -- rules we run, on our clock, for the whole season
--   strategy_keys -- a secret a program presents to place orders itself
--
-- Neither is a second kind of account. A strategy and a key both act on the
-- account their owner already entered the season with, exactly as the Telegram
-- link does. One entry, one balance, one row on the board.


-- ---------------------------------------------------------------------------
-- how an order arrived
-- ---------------------------------------------------------------------------
-- A trade row could not say whether a person or a program placed it, and once
-- automated entrants rank beside humans that silence stops being acceptable.
--
-- Added as a column rather than folded into the leaf hash, and it matters that
-- the difference is stated. The leaf is what makes a record checkable by a
-- stranger, and its shape is fixed by the engine version a season committed to;
-- changing it now would invalidate every commit already on chain. So this is an
-- append-only fact that cannot be rewritten, which is weaker than a sealed one,
-- and it belongs in the leaf at the next engine version bump.
--
-- Defaulting to 'web' is right for every row that already exists: the only ways
-- to trade before this migration were the site and the Telegram bot, and the bot
-- did not exist when any of these rows were written.
ALTER TABLE trades ADD COLUMN source TEXT NOT NULL DEFAULT 'web'
  CHECK (source IN ('web', 'telegram', 'form', 'api'));

-- Counting a strategy's trades for the day is the daily cap's whole enforcement,
-- so it must not be a scan of the account's history.
CREATE INDEX trades_source_idx ON trades (account_id, source, created_at);


-- ---------------------------------------------------------------------------
-- strategies
-- ---------------------------------------------------------------------------
-- A set of rules we run on the owner's behalf until the season ends or they
-- stop it.
--
-- The rules are JSON rather than columns. They are read as a whole, written as a
-- whole, versioned as a whole, and the shape will grow; a column per condition
-- would mean a migration every time a new one is offered. What must not be
-- flexible is the *validation*, which lives in one place in code and runs before
-- anything is stored.
--
-- `rules_version` is here so a strategy stored under one shape is never fed to a
-- reader expecting another. A strategy that cannot be read is stopped rather
-- than guessed at.
CREATE TABLE strategies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pubkey    TEXT    NOT NULL REFERENCES users (pubkey),
  season_id      INTEGER NOT NULL REFERENCES seasons (id),
  name           TEXT    NOT NULL,

  rules          TEXT    NOT NULL,
  rules_version  INTEGER NOT NULL DEFAULT 1,

  -- 'stopped' is where a strategy goes when its owner stops it, when the season
  -- ends, and when it breaks. `stopped_reason` says which, because "it is not
  -- running" and "it stopped itself twelve hours ago because the account ran out
  -- of balance" are different facts and the owner is owed the second one.
  status         TEXT    NOT NULL CHECK (status IN ('draft', 'running', 'stopped')),
  stopped_reason TEXT,

  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  started_at     INTEGER,
  stopped_at     INTEGER
);

CREATE INDEX strategies_owner_idx ON strategies (user_pubkey, season_id);
CREATE INDEX strategies_running_idx ON strategies (status, season_id);

-- One running strategy per account per season.
--
-- Not a preference. Two strategies on one balance would each size their entries
-- against a balance the other is spending, so both would size wrongly and
-- whichever lost the race would fail on a balance check it had every reason to
-- expect to pass. Enforced here rather than in code because it is the sort of
-- rule that a second code path forgets.
CREATE UNIQUE INDEX strategies_one_running
  ON strategies (user_pubkey, season_id)
  WHERE status = 'running';


-- ---------------------------------------------------------------------------
-- strategy_keys
-- ---------------------------------------------------------------------------
-- A secret a program presents to place orders on its owner's account.
--
-- The key itself is never stored. What is stored is its SHA-256, which is enough
-- to recognise a key that is presented and useless to anybody who reads this
-- table. A leaked database should not be a leaked set of trading keys, and the
-- only way to promise that is to be unable to produce one.
--
-- `prefix` is the visible head of the key, kept so the owner can tell two keys
-- apart in a list without the list containing anything worth stealing.
--
-- Revoked rather than deleted, so that a key which traded a season is still
-- explicable afterwards. Nothing in this system is ever erased.
CREATE TABLE strategy_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pubkey  TEXT    NOT NULL REFERENCES users (pubkey),
  name         TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,
  key_hash     TEXT    NOT NULL UNIQUE,

  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX strategy_keys_owner_idx ON strategy_keys (user_pubkey, created_at);


-- ---------------------------------------------------------------------------
-- strategy_events
-- ---------------------------------------------------------------------------
-- What the runner did, and what it declined to do.
--
-- A hosted strategy is otherwise a black box: it either trades or it does not,
-- and an owner watching it do nothing has no way to tell a strategy whose
-- conditions have not been met from one that is quietly broken. The difference
-- matters enough to write down.
--
-- Deliberately including refusals. "Skipped: would have moved the price 812 bps,
-- cap is 150" is the most useful line this table can hold, and a log that only
-- recorded successes would be a log that flatters the runner.
--
-- Trimmed by the retention sweep after a season's length rather than kept for
-- ever: it is an explanation, not a record, and the trades themselves are the
-- record. A row lands here every time a running strategy declines to do
-- something, which is most ticks of most strategies, so unswept this would be
-- the next table to fill the volume.
CREATE TABLE strategy_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL REFERENCES strategies (id),
  at          INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN (
                'started', 'stopped', 'entered', 'exited', 'skipped', 'failed', 'capped'
              )),
  mint        TEXT,
  detail      TEXT    NOT NULL
);

CREATE INDEX strategy_events_by_strategy ON strategy_events (strategy_id, at);
