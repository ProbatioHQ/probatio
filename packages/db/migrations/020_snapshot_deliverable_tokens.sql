-- The tokens the venue could actually hand over, at the moment a fill was quoted.
--
-- The trade leaf commits to `deliverableTokens`, the buy cap the engine used. On
-- a bonding curve that is the real token reserve, which differs from the virtual
-- token reserve the price comes from. The snapshot stored only the virtual
-- reserve, so rebuilding a leaf substituted the wrong number, its hash did not
-- match the one recorded at trade time, and every bonding-curve trade failed to
-- commit and failed to verify. This stores the value the leaf was actually built
-- from, so the rebuild reproduces it.
--
-- Existing rows are backfilled to the token reserve: correct for graduated pool
-- trades (where deliverable equals the reserve) and the best available guess for
-- older curve rows, which predate the fix and are dev data.

ALTER TABLE pool_snapshots ADD COLUMN deliverable_tokens TEXT NOT NULL DEFAULT '0';
UPDATE pool_snapshots SET deliverable_tokens = token_reserve WHERE deliverable_tokens = '0';
