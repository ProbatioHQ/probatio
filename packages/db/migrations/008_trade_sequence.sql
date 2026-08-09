-- A trade's position in its trader's season.
--
-- The merkle leaf commits to this, so it has to be real. It was written as a
-- constant zero when trading first landed, which meant two identical trades
-- hashed identically — precisely what a sequence exists to prevent — and left
-- the keeper unable to rebuild a leaf, because nothing recorded where the trade
-- sat.
--
-- Assigned inside the same transaction that inserts the trade, so it cannot be
-- read, used and then claimed by someone else. The unique index is what makes
-- that guarantee rather than a hope.

ALTER TABLE trades ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX trades_sequence_idx ON trades (account_id, sequence);
