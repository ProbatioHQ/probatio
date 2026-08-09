-- A payment the server has asked for but has not seen.
--
-- Separate from `payments` because a payment is a transaction that exists on
-- chain, and this is a promise about one that does not yet. The payments table
-- requires a signature, and an intent has none until somebody signs.
--
-- The reason to store intents at all rather than sign them into a stateless
-- token: a user who approves the transaction and then closes the tab has paid,
-- and nothing will ever tell us so. The reference recorded here is what makes
-- that payment findable on chain afterwards, so they are credited instead of
-- being asked to pay twice.

CREATE TABLE payment_intents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The random account attached to the transfer. Unique because two intents
  -- sharing one would let a single payment answer both.
  reference     TEXT    NOT NULL UNIQUE,

  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),
  season_id     INTEGER REFERENCES seasons (id),
  purpose       TEXT    NOT NULL CHECK (purpose IN ('season_entry','coach_upgrade')),

  -- Recorded rather than read from configuration at verification time. If the
  -- treasury address is ever rotated, a payment already in flight must still be
  -- checked against the address the user was actually shown.
  recipient     TEXT    NOT NULL,
  amount        TEXT    NOT NULL CHECK (amount = '0' OR (length(amount) > 0 AND amount NOT GLOB '*[^0-9]*' AND amount NOT GLOB '0*')),

  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,

  -- Set when the payment is found and verified. Null means outstanding.
  payment_id    INTEGER REFERENCES payments (id)
);

CREATE INDEX payment_intents_user_idx ON payment_intents (user_pubkey, created_at DESC);

-- Outstanding intents, for the sweep that finds payments nobody reported.
CREATE INDEX payment_intents_open_idx ON payment_intents (expires_at) WHERE payment_id IS NULL;
