-- ---------------------------------------------------------------------------
-- Head to head duels.
-- ---------------------------------------------------------------------------
--
-- One trader against one, over a window both agreed to, on the account each of
-- them already entered the season with. There is no duel balance and no duel
-- engine: a duel is a *scored window*, not a separate game. The trades inside it
-- are ordinary season trades that also count toward the leaderboard, filled by
-- the same engine at the same latency, and they would have happened the same way
-- with no duel open.
--
-- WHY IT IS SCORED THAT WAY
--
-- The alternative is a fresh balance per duel, which sounds cleaner and is
-- worse. It would mean a second kind of account, a second set of positions, and
-- a trade that counts in one place and not the other. Every feature here that
-- could have introduced a second account (strategies, the Telegram link) refused
-- to, for the same reason: one entry, one balance, one row.
--
-- WHAT IS ACTUALLY STORED
--
-- Two equity snapshots per trader, taken at the moment the duel starts and the
-- moment it ends, and the return between them. Equity is the account's SOL plus
-- its open positions marked at what they are worth, which is the same figure the
-- leaderboard shows, read by the same code. A duel that computed its own idea of
-- what an account is worth would eventually disagree with the board, and then
-- both numbers are suspect.
--
-- A HONEST LIMIT, WRITTEN DOWN
--
-- A position whose price cannot be read is counted at what it cost, exactly as
-- the all-time board counts it. That is a fallback, not a price, so the count of
-- unpriced positions is stored at both ends. If either end had one, the result
-- says so rather than presenting a figure that is part measurement and part
-- assumption without saying which.
--
-- NO STAKE IN THIS TABLE
--
-- The roadmap says a duel can carry a stake and the winner takes the pot. That
-- needs money to move, and money moving needs the claim path the seasons use.
-- Rather than store a `stake` column that nothing honours, there is no column:
-- when a stake can actually be paid out, it arrives as a migration alongside the
-- code that pays it. A column that promises something no code delivers is the
-- kind of quiet lie this project exists not to tell.
CREATE TABLE duels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL REFERENCES seasons (id),

  -- Who offered, and who was offered it. The order is kept rather than
  -- normalised: "they challenged me" and "I challenged them" are different
  -- facts, and only one of the two people may accept.
  challenger    TEXT    NOT NULL REFERENCES users (pubkey),
  opponent      TEXT    NOT NULL REFERENCES users (pubkey),

  -- offered  -> waiting on the opponent
  -- live     -> accepted, running, being scored
  -- settled  -> over, with a result
  -- declined -> the opponent said no
  -- withdrawn-> the challenger took it back before it was accepted
  -- expired  -> nobody answered in time
  --
  -- Refusals are kept rather than deleted, so a trader who declines eleven
  -- duels has a record of having done so. Nothing here is ever erased.
  status        TEXT    NOT NULL CHECK (status IN (
                  'offered', 'live', 'settled', 'declined', 'withdrawn', 'expired'
                )),

  window_seconds   INTEGER NOT NULL,

  created_at       INTEGER NOT NULL,
  -- An offer nobody answers must not sit open for ever, holding the pair's one
  -- duel slot against them.
  offer_expires_at INTEGER NOT NULL,
  started_at       INTEGER,
  ends_at          INTEGER,
  settled_at       INTEGER,

  -- Equity in lamports, as text. A lamport balance does not fit a JSON number
  -- and a balance rounded is a result rounded.
  challenger_open  TEXT,
  opponent_open    TEXT,
  challenger_close TEXT,
  opponent_close   TEXT,

  -- The return between the two snapshots, in basis points.
  challenger_bps   INTEGER,
  opponent_bps     INTEGER,

  -- How many held positions could not be priced when each snapshot was taken.
  -- Zero at both ends means the result is measured throughout.
  unpriced_open    INTEGER NOT NULL DEFAULT 0,
  unpriced_close   INTEGER NOT NULL DEFAULT 0,

  -- The winner's pubkey. NULL on a settled duel means a draw, which is why the
  -- status is what says whether it is over and this column is not.
  winner           TEXT,

  -- A hash over the settled result, so the outcome can be quoted without the
  -- quoter being trusted.
  seal             TEXT
);

CREATE INDEX duels_challenger_idx ON duels (challenger, created_at);
CREATE INDEX duels_opponent_idx   ON duels (opponent, created_at);

-- The settler asks for duels past their end, every tick, for ever. Without this
-- that is a scan of every duel ever fought.
CREATE INDEX duels_due_idx ON duels (status, ends_at);

-- Offers that need expiring, found the same way.
CREATE INDEX duels_offers_idx ON duels (status, offer_expires_at);

-- One live duel per person at a time.
--
-- Not a preference. Two live duels scored off one account would both be
-- measuring the same trades, so a single good fill would win two duels at once
-- and a trader could stack ten of them against ten opponents on one piece of
-- luck. Enforced twice, once per side, because a person may be the challenger in
-- one and the opponent in another and either would be a second live duel.
CREATE UNIQUE INDEX duels_one_live_challenger
  ON duels (challenger) WHERE status = 'live';
CREATE UNIQUE INDEX duels_one_live_opponent
  ON duels (opponent) WHERE status = 'live';
