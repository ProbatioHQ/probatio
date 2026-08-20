-- Fills pushed into a chat as they land.
--
-- Keyed on the chat rather than the person, unlike the account link. A watch is
-- a thing a room subscribes to: somebody sets one up in a group and everybody
-- in the group is meant to see it. The person who asked is recorded anyway, so
-- that a watch can be attributed and so a room cannot be quietly filled up by
-- one member.
--
-- The cursor is the whole design. Deliveries are driven by the trade id, which
-- is an autoincrementing integer on an append-only table, so "what has this
-- chat already been told" is a single number and "what is new" is a range. No
-- timestamps, no windows, and nothing that can be delivered twice because two
-- passes overlapped.
--
-- A new watch starts at the trader's newest fill rather than at zero. Otherwise
-- subscribing to somebody with two thousand fills replays two thousand fills
-- into the room.
CREATE TABLE telegram_watch (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  -- Who asked for it. Not the same as whose fills arrive.
  telegram_user_id INTEGER NOT NULL,
  -- The wallet being watched. Deliberately not a foreign key: somebody can
  -- watch a trader who has never touched this platform, and the watch simply
  -- delivers nothing until they do.
  trader        TEXT    NOT NULL,
  last_trade_id INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,

  -- One watch per trader per chat. Asking twice is not two subscriptions.
  UNIQUE (chat_id, trader)
);

CREATE INDEX telegram_watch_by_chat ON telegram_watch (chat_id);
CREATE INDEX telegram_watch_by_trader ON telegram_watch (trader);

-- What the notifier joins against.
--
-- The existing index on trades leads with season_id, which is no use to a
-- lookup that knows a wallet and a cursor and nothing about which season the
-- fill landed in. Without this the delivery pass scans the trade table every
-- twenty seconds, which is fine at ten thousand rows and is not fine later.
CREATE INDEX trades_user_idx ON trades (user_pubkey, id);
