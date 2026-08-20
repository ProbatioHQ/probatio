-- Which Telegram updates have already been handled.
--
-- Telegram retries an update until the webhook answers 200, and it will retry
-- one that was handled if the answer was slow or lost. Without a record of what
-- has been seen, a retried update is a second trade: the same tap, filled
-- twice, on an account whose whole point is that its record is exact.
--
-- The id is the primary key because that is the question being asked. Nothing
-- else about the update is kept: the payload is Telegram's, it can be large,
-- and holding it would be storing other people's messages for no reason.
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at   INTEGER NOT NULL
);

CREATE INDEX telegram_updates_by_time ON telegram_updates (seen_at);
