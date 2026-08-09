-- Cached token names, symbols and images.
--
-- Two separate fetches feed this table and they fail independently. The
-- on-chain metadata account is one RPC read and either exists or does not; the
-- off-chain JSON it points at lives on somebody else's IPFS gateway and can be
-- slow, missing, malformed or hostile.
--
-- So each side carries its own timestamp. A token whose gateway is down still
-- has a usable name and symbol from chain, and the off-chain fetch can be
-- retried later without redoing the part that already worked.
--
-- `offchain_error` records the last failure rather than discarding it, so a
-- token that never resolves can be told apart from one that was never tried.

CREATE TABLE token_metadata (
  mint                TEXT PRIMARY KEY,

  -- From the Metaplex metadata account.
  name                TEXT,
  symbol              TEXT,
  uri                 TEXT,
  update_authority    TEXT,
  decimals            INTEGER,
  onchain_fetched_at  INTEGER NOT NULL,

  -- From the JSON document `uri` points at. Attacker-controlled.
  offchain_name       TEXT,
  offchain_symbol     TEXT,
  description         TEXT,
  image_url           TEXT,
  offchain_fetched_at INTEGER,
  offchain_error      TEXT,

  CHECK (decimals IS NULL OR (decimals >= 0 AND decimals <= 18))
);

-- Drives the refresh sweep: oldest off-chain reads first, and rows that have
-- never been attempted sort first of all.
CREATE INDEX token_metadata_stale_idx ON token_metadata (offchain_fetched_at);
