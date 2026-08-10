-- Making a session revocable.
--
-- Session tokens are stateless: an HMAC over a payload, verified with a secret
-- and nothing else. That makes them cheap to check and impossible to withdraw.
-- A cookie copied off a shared machine, or lifted from a backup, stayed valid
-- for its full life no matter what the wallet's owner did — signing out only
-- deleted the copy in that one browser.
--
-- The epoch fixes that without giving up stateless verification. It is stamped
-- into the token when the session is issued and compared on every read; raising
-- it invalidates every token issued before, everywhere, at once. That is what
-- signing out now does, and it is the lever to pull if a wallet is compromised.
--
-- Costs one indexed read per authenticated request, which is why the read is
-- memoised per request rather than repeated by every caller that asks who is
-- signed in.

ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
