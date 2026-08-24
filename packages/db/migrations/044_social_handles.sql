-- ---------------------------------------------------------------------------
-- the X account a token names, reduced to the account
-- ---------------------------------------------------------------------------
-- The strongest signal anybody asked for is whether the account promoting a
-- token has promoted a pile of others. The complete version of that needs an
-- archive of deleted posts, which this does not have and cannot cheaply build.
--
-- What it does have is its own index: forty thousand launches, each carrying
-- whatever X link its creator wrote into the metadata. Counting how many of
-- them name the same account answers a narrower question honestly — not "has
-- this account promoted and deleted", but "is this account attached to eleven
-- other tokens we have seen" — and needs nobody else's data.
--
-- Stored as a normalised handle rather than matched on the URL, because the
-- same account is written a dozen ways: with and without www, as x.com and
-- twitter.com, with a trailing slash, with tracking parameters, in any case.
-- Grouping raw URLs would count each spelling as a different account and report
-- a serial promoter as eleven separate first-timers.
--
-- Null where the link names no account: plenty of tokens point their "twitter"
-- at a single post in somebody else's thread, which says nothing about who is
-- behind the token.
ALTER TABLE token_metadata ADD COLUMN twitter_handle TEXT;

-- The count is the whole point of the column, so it must not be a scan.
CREATE INDEX token_metadata_handle_idx ON token_metadata (twitter_handle)
  WHERE twitter_handle IS NOT NULL;
