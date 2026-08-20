-- When a trader last looked at who follows them.
--
-- Gaining an audience is the whole point of a record that can be trusted, and
-- until now it happened silently: somebody could pick up twenty followers and
-- never find out. This is what makes "three new followers" answerable without
-- storing a notification per follow, which would be a second table growing
-- forever to hold a fact the follow's own timestamp already implies.
--
-- Its own table rather than a column on `users`. That table is pinned by a test
-- to exactly the columns authentication needs, and the pin exists precisely so
-- that unrelated state cannot drift onto the identity everything else keys on.
-- A mark about a social feature is not part of who somebody is, so it lives
-- with the social feature.
--
-- A missing row means never looked, which is the correct starting point for
-- everybody who already exists.
CREATE TABLE follow_reads (
  pubkey   TEXT    PRIMARY KEY REFERENCES users (pubkey) ON DELETE CASCADE,
  seen_at  INTEGER NOT NULL
);
