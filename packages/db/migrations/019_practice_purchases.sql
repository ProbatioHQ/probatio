-- ---------------------------------------------------------------------------
-- Buying practice balance
-- ---------------------------------------------------------------------------
-- A third thing somebody can pay for: more play money for free play.
--
-- `purpose` is constrained rather than free text, which is the right call and
-- means adding a value is a table rebuild — SQLite has no way to amend a CHECK
-- in place. Both tables carry the same constraint and both are rebuilt here.
--
-- What this deliberately does NOT touch is a ranked season. A season's starting
-- balance is fixed and hashed into its published ruleset, so purchased balance
-- cannot reach a leaderboard by construction rather than by a rule somebody
-- remembers to apply. That matters more than it sounds: ranking is by percent
-- return, so at first glance buying more changes nothing — until a trader who
-- is down fifty percent buys a hundred SOL, and their loss is diluted into
-- almost nothing. The season would stop measuring skill and start measuring
-- spend, which is the one thing this whole project exists not to be.

PRAGMA foreign_keys = OFF;

CREATE TABLE payments_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),
  season_id     INTEGER REFERENCES seasons (id),
  purpose       TEXT    NOT NULL CHECK (purpose IN ('season_entry','coach_upgrade','practice_sol')),
  amount        TEXT    NOT NULL CHECK (amount = '0' OR (length(amount) > 0 AND amount NOT GLOB '*[^0-9]*' AND amount NOT GLOB '0*')),
  tx_signature  TEXT    NOT NULL UNIQUE,
  status        TEXT    NOT NULL CHECK (status IN ('pending','verified','failed')),
  created_at    INTEGER NOT NULL,
  verified_at   INTEGER
);

INSERT INTO payments_new
  (id, user_pubkey, season_id, purpose, amount, tx_signature, status, created_at, verified_at)
  SELECT id, user_pubkey, season_id, purpose, amount, tx_signature, status, created_at, verified_at
    FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;
CREATE INDEX payments_user_idx ON payments (user_pubkey, season_id);


CREATE TABLE payment_intents_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reference     TEXT    NOT NULL UNIQUE,
  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),
  season_id     INTEGER REFERENCES seasons (id),
  purpose       TEXT    NOT NULL CHECK (purpose IN ('season_entry','coach_upgrade','practice_sol')),
  recipient     TEXT    NOT NULL,
  amount        TEXT    NOT NULL CHECK (amount = '0' OR (length(amount) > 0 AND amount NOT GLOB '*[^0-9]*' AND amount NOT GLOB '0*')),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  payment_id    INTEGER REFERENCES payments (id),

  -- Evidence columns added after the table was first created.
  funder                 TEXT,
  wallet_first_seen_at   INTEGER,
  wallet_signature_count INTEGER,
  evidence_flags         TEXT
);

INSERT INTO payment_intents_new
  (id, reference, user_pubkey, season_id, purpose, recipient, amount, created_at, expires_at,
   payment_id, funder, wallet_first_seen_at, wallet_signature_count, evidence_flags)
  SELECT id, reference, user_pubkey, season_id, purpose, recipient, amount, created_at, expires_at,
         payment_id, funder, wallet_first_seen_at, wallet_signature_count, evidence_flags
    FROM payment_intents;

DROP TABLE payment_intents;
ALTER TABLE payment_intents_new RENAME TO payment_intents;
CREATE INDEX payment_intents_user_idx ON payment_intents (user_pubkey, created_at DESC);
CREATE INDEX payment_intents_open_idx ON payment_intents (expires_at) WHERE payment_id IS NULL;

PRAGMA foreign_keys = ON;
