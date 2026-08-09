-- Sign-in challenges.
--
-- A nonce is issued for one wallet, lives for a few minutes, and can be
-- redeemed exactly once. `consumed_at` is what makes it single-use: a replayed
-- signature finds the row already spent and is rejected even though the
-- signature itself is perfectly valid.
--
-- These live in the database rather than in process memory so a restart does
-- not invalidate every in-flight sign-in, and so more than one instance can
-- serve the flow later without sharing state some other way.

CREATE TABLE auth_nonces (
  nonce       TEXT    PRIMARY KEY,
  pubkey      TEXT    NOT NULL,
  domain      TEXT    NOT NULL,
  uri         TEXT    NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > issued_at)
);

-- Supports the sweep of stale challenges. Expired rows carry no value and
-- there is no reason to keep them.
CREATE INDEX auth_nonces_expiry_idx ON auth_nonces (expires_at);
