-- The payout engine: entry money in a vault, a finalized results root, and
-- per-winner claims proven against it.
--
-- The season already carried its on-chain address (onchain_pubkey) and a
-- finalized_at. What it lacked is the results root the program records at
-- finalize_season, which a winner's claim is proven against, and a mark for a
-- season that was voided rather than finalized. The vault is the program
-- address derived from the season, so it is not stored.
--
-- The entry gains the on-chain Entry it created by paying into the vault, the
-- fee it paid, and, once the season is finalized, the frozen numbers its result
-- leaf was built from plus the merkle proof to claim it. rank, trade_count,
-- payout and payout_tx_signature already existed unused; these complete the
-- claim. claimed_at and refunded_at record which door the money left by, and
-- guard against it leaving twice.

ALTER TABLE seasons ADD COLUMN results_root TEXT
  CHECK (results_root IS NULL
    OR (length(results_root) = 64 AND results_root NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE seasons ADD COLUMN voided_at INTEGER;

ALTER TABLE entries ADD COLUMN onchain_entry_pubkey TEXT;
ALTER TABLE entries ADD COLUMN entry_tx_signature TEXT;

ALTER TABLE entries ADD COLUMN paid TEXT
  CHECK (paid IS NULL OR paid = '0'
    OR (length(paid) > 0 AND paid NOT GLOB '*[^0-9]*' AND paid NOT GLOB '0*'));
ALTER TABLE entries ADD COLUMN starting_balance TEXT
  CHECK (starting_balance IS NULL OR starting_balance = '0'
    OR (length(starting_balance) > 0 AND starting_balance NOT GLOB '*[^0-9]*'
      AND starting_balance NOT GLOB '0*'));
ALTER TABLE entries ADD COLUMN final_equity TEXT
  CHECK (final_equity IS NULL OR final_equity = '0'
    OR (length(final_equity) > 0 AND final_equity NOT GLOB '*[^0-9]*'
      AND final_equity NOT GLOB '0*'));
ALTER TABLE entries ADD COLUMN return_bps INTEGER;
ALTER TABLE entries ADD COLUMN proof TEXT;

ALTER TABLE entries ADD COLUMN claimed_at INTEGER;
ALTER TABLE entries ADD COLUMN refunded_at INTEGER;
