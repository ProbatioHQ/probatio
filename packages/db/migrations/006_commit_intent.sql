-- Write-ahead for on-chain commits.
--
-- A commit spans two systems that cannot be updated together: a Solana
-- transaction and this database. Whichever is written second, a crash in
-- between leaves them disagreeing — and for a hash chain that disagreement is
-- permanent. Committing the same batch twice folds it into the accumulator
-- twice, and no later correction can unfold it.
--
-- So the intent is written here *before* the transaction is sent, carrying the
-- accumulator value the keeper expects the chain to hold afterwards. On
-- restart, any unconfirmed row can be reconciled by reading the chain:
--
--   chain == predicted        the transaction landed, mark it confirmed
--   chain == previous         it never landed, safe to resend
--   chain == neither          something else wrote to this record; stop
--
-- Without the prediction stored, that third case is indistinguishable from the
-- second, and the keeper would resend into a chain that had already moved.

ALTER TABLE commits ADD COLUMN predicted_accumulator TEXT;
ALTER TABLE commits ADD COLUMN previous_accumulator TEXT;
ALTER TABLE commits ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commits ADD COLUMN failed_reason TEXT;

-- Finds the work a restarting keeper has to reconcile before doing anything
-- new.
CREATE INDEX commits_pending_idx ON commits (season_id, user_pubkey, id)
  WHERE confirmed_at IS NULL;
