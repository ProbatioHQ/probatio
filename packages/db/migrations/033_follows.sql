-- Who is watching whom.
--
-- The point of a record nobody can edit is that it can gather an audience on
-- its own merit, so this is the table that lets it. A follow is one row: the
-- wallet doing the following, the wallet being followed, and when.
--
-- Both sides reference `users`, so a follow cannot name a wallet that has never
-- signed in. That matters more here than it looks: without it, anybody could
-- inflate a follower count by following from addresses that do not exist, and a
-- number nobody can trust is worse on this site than no number at all.
--
-- ON DELETE CASCADE on both, because a user row going away should take its
-- follows with it rather than leaving rows pointing at nothing. The account
-- outage earlier this month was exactly a session outliving its users row, and
-- this table should not be able to repeat that shape.
CREATE TABLE follows (
  follower_pubkey  TEXT    NOT NULL REFERENCES users (pubkey) ON DELETE CASCADE,
  followed_pubkey  TEXT    NOT NULL REFERENCES users (pubkey) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,

  -- One follow per pair, and the primary key is the uniqueness constraint
  -- rather than a separate index, so following twice is a no-op instead of a
  -- second row inflating a count.
  PRIMARY KEY (follower_pubkey, followed_pubkey),

  -- Following yourself is not a relationship, and allowing it would mean every
  -- follower count needs a special case at read time.
  CHECK (follower_pubkey <> followed_pubkey)
);

-- The primary key already serves "who does this wallet follow" and "is A
-- following B". This is the other direction: the follower count on a profile,
-- and the audience list.
CREATE INDEX follows_by_followed ON follows (followed_pubkey, created_at DESC);
