-- How far along the bonding curve a token is.
--
-- The feed is three lanes rather than one list, the way a trader actually
-- thinks about pump.fun: what just launched, what is close to graduating, and
-- what already has. Which lane a token belongs in is a fact about its bonding
-- curve account, not about the launch event, so it is read from chain and
-- cached here rather than inferred from age.
--
-- Separate from `launches` on purpose. A launch is immutable — it happened, at
-- a slot, with a name. Curve state is the opposite: it changes on every trade,
-- and mixing a row that is written once with one that is rewritten constantly
-- would put the feed's hottest write on the table its search index lives on.

CREATE TABLE curve_state (
  mint                TEXT PRIMARY KEY,

  -- Straight off the account, as integers. Lamports and base units, never a
  -- float — the same rule as everywhere else money is counted here.
  real_sol_reserves   TEXT    NOT NULL,
  real_token_reserves TEXT    NOT NULL,

  -- Progress towards graduation in basis points, 0 to 10000. Derived, and
  -- stored rather than computed on read so the feed can order by it without
  -- pulling every row into memory to sort.
  progress_bps        INTEGER NOT NULL,

  -- True once the curve has graduated and trading moved to the AMM. On
  -- graduation every reserve field is zeroed, so this is the only field that
  -- distinguishes a graduated token from an unreadable one.
  complete            INTEGER NOT NULL DEFAULT 0,

  -- When the account was last read. A lane built from stale numbers is worse
  -- than one that admits it is stale, so this is served to the client.
  updated_at          INTEGER NOT NULL,

  CHECK (progress_bps >= 0 AND progress_bps <= 10000),
  CHECK (complete IN (0, 1))
);

-- The "about to bond" lane: incomplete curves, furthest along first.
CREATE INDEX curve_state_progress_idx ON curve_state (complete, progress_bps DESC);

-- Choosing what to refresh next: whatever was read longest ago.
CREATE INDEX curve_state_stale_idx ON curve_state (updated_at);
