-- The links a launcher put in their metadata document.
--
-- pump.fun's documents carry `twitter`, `website` and `telegram`, and this
-- fetched every one of them and kept four fields: name, symbol, description and
-- image. So a token page here showed no way to reach the project while every
-- other client showed two, and the data had already been downloaded and thrown
-- away. Checked against Rococo Basilisk, whose document holds a twitter and a
-- website link and whose row here held neither, because there was no column.
--
-- Stored as given, minus anything that is not https, and never presented as
-- verified. These are the launcher's claims about themselves: on that same
-- token the "website" is an x.com link, which is exactly the sort of thing a
-- reader should be allowed to see and decide about rather than have tidied up.
ALTER TABLE token_metadata ADD COLUMN twitter_url TEXT;
ALTER TABLE token_metadata ADD COLUMN website_url TEXT;
ALTER TABLE token_metadata ADD COLUMN telegram_url TEXT;
