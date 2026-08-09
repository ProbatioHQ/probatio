-- Which wallet was active on which day.
--
-- The whole of the product analytics. One row per wallet per UTC day, and
-- nothing else recorded: no IP address, no user agent, no page views, no
-- device fingerprint, no session replay.
--
-- That is a deliberate limit rather than a starting point. A hosted analytics
-- product would answer more questions, and would also mean an account, an email
-- and a payment method belonging to whoever runs this — which undoes the
-- anonymity the project is built with, in exchange for numbers this table
-- already answers.
--
-- The wallet address is public by construction; it is on chain next to every
-- trade. The day is the coarsest unit that can answer whether somebody came
-- back. Storing a timestamp instead would let this table describe habits, which
-- is more than it needs to know.

CREATE TABLE activity (
  user_pubkey  TEXT    NOT NULL REFERENCES users (pubkey),
  -- Days since the epoch, UTC.
  day          INTEGER NOT NULL,
  -- Whether they placed a trade that day, as opposed to only looking.
  traded       INTEGER NOT NULL DEFAULT 0 CHECK (traded IN (0, 1)),

  PRIMARY KEY (user_pubkey, day)
);

CREATE INDEX activity_day_idx ON activity (day);
