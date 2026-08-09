-- Display names.
--
-- Deliberately a separate table rather than a column on `users`. A name is not
-- an attribute of a trader, it is a claim on a scarce string that can be given
-- up, taken away, or refused — and removing one must not touch the row a result
-- belongs to.
--
-- Nothing here is committed on chain and nothing here enters a hash. The chain
-- commits to public keys. Clearing a name changes no record and invalidates no
-- proof, which is the property that makes moderating names safe to do at all.
--
-- Several rows per wallet, not one. A cleared row has to stay so its key stays
-- reserved, and the same wallet still has to be able to hold a different name
-- afterwards. With one row per wallet those two requirements fight, and the
-- loser is the trader: moderated once, never named again. The string is what
-- gets banned here, not the person.

CREATE TABLE display_names (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_pubkey   TEXT    NOT NULL REFERENCES users (pubkey),

  -- As typed, for display.
  name          TEXT    NOT NULL,

  -- Folded: case, separators and lookalike characters collapsed. Uniqueness is
  -- on this rather than on the name, because two strings a reader cannot tell
  -- apart are one name for the purpose of impersonating somebody.
  name_key      TEXT    NOT NULL UNIQUE,

  claimed_at    INTEGER NOT NULL,

  -- Set when a name is taken away. The row is kept rather than deleted so the
  -- key stays reserved: releasing a moderated name straight back into the pool
  -- hands it to whoever was waiting for it.
  cleared_at    INTEGER,
  cleared_note  TEXT
);

-- One live name per wallet. Cleared rows are exempt, which is what lets a
-- wallet keep a history of names while only ever showing one.
CREATE UNIQUE INDEX display_names_one_live_idx
  ON display_names (user_pubkey) WHERE cleared_at IS NULL;

CREATE INDEX display_names_active_idx ON display_names (cleared_at) WHERE cleared_at IS NULL;
