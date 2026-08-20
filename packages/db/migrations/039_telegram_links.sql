-- Which Telegram account belongs to which wallet.
--
-- Keyed on the person rather than the chat. Somebody types /buy in a group on
-- Monday and in a direct message on Tuesday, and it is the same account both
-- times; keying on the chat would make a wallet's positions depend on which
-- room they happened to be standing in.
--
-- One wallet per Telegram account and one Telegram account per wallet. Without
-- the second constraint two people could point at the same wallet and trade
-- each other's balance, which is the sort of thing that is obvious afterwards.
CREATE TABLE telegram_links (
  telegram_user_id INTEGER PRIMARY KEY,
  user_pubkey      TEXT    NOT NULL UNIQUE REFERENCES users(pubkey),
  linked_at        INTEGER NOT NULL
);

-- A code handed out in chat and redeemed on the site.
--
-- The link cannot be made from Telegram alone: Telegram knows who is typing but
-- has no idea which wallet they own, and a bot that took a pasted address on
-- trust would let anybody claim anybody's record. So the bot issues a code, the
-- site asks for a signature, and the signature is what proves the wallet.
--
-- Codes expire and are single use, both enforced on read.
CREATE TABLE telegram_link_codes (
  code             TEXT    PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  -- Where to say it worked, since the claim happens in a browser and the person
  -- who started it is waiting in a chat.
  chat_id          INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  claimed_at       INTEGER
);

CREATE INDEX telegram_link_codes_by_user ON telegram_link_codes (telegram_user_id);
CREATE INDEX telegram_link_codes_by_time ON telegram_link_codes (created_at);
