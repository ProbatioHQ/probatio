-- A prize somebody put up rather than one the entries paid for.
--
-- The seed season exists so the leaderboard is not empty on the day the first
-- outsider looks at it, and an empty board is worth less than no board. But it
-- cannot charge for entry: the published commitment is that the upgrade
-- authority is burned before any season takes money, and the program has no
-- refund instruction yet.
--
-- So the first season is free and the prize is sponsored. The pot is then two
-- things added together rather than one, and they are stored separately because
-- they mean different things: entries are money the entrants are owed back if
-- the season is void, and a sponsored prize is money that was never theirs.

ALTER TABLE seasons ADD COLUMN sponsor_lamports TEXT NOT NULL DEFAULT '0'
  CHECK (sponsor_lamports = '0' OR (length(sponsor_lamports) > 0
    AND sponsor_lamports NOT GLOB '*[^0-9]*' AND sponsor_lamports NOT GLOB '0*'));
