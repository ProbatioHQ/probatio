-- What the chain said about a wallet when it entered.
--
-- Gathered once, at entry, and never recomputed. That timing is the point.
--
-- Farming the prize does not pay — an attacker holding k of N entries expects
-- k/N of the pot whatever the payout shape, which after the house cut is a
-- guaranteed small loss. What pays is farming a track record: run twenty
-- wallets over three seasons, discard the nineteen that failed, and present the
-- survivor as skill to whoever is deciding where capital goes.
--
-- By the time that decision is made the nineteen are gone and unfindable. So
-- the link between them is written down while it is still cheap and true.
--
-- On both tables because the check has to happen before money moves: an entry
-- that would be refused should be refused before it is paid for, not after.

ALTER TABLE payment_intents ADD COLUMN funder TEXT;
ALTER TABLE payment_intents ADD COLUMN wallet_first_seen_at INTEGER;
ALTER TABLE payment_intents ADD COLUMN wallet_signature_count INTEGER;
ALTER TABLE payment_intents ADD COLUMN evidence_flags TEXT;

ALTER TABLE entries ADD COLUMN funder TEXT;
ALTER TABLE entries ADD COLUMN wallet_first_seen_at INTEGER;
ALTER TABLE entries ADD COLUMN wallet_signature_count INTEGER;
ALTER TABLE entries ADD COLUMN evidence_flags TEXT;

-- The clustering query: how many entries in this season came from one source.
CREATE INDEX entries_season_funder_idx ON entries (season_id, funder);

-- Outstanding intents count toward the limit too. Without this, fifty intents
-- created in the same second would each see zero siblings and all pass.
CREATE INDEX payment_intents_season_funder_idx ON payment_intents (season_id, funder);
