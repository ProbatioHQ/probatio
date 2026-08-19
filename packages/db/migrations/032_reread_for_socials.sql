-- Re-read the documents already cached, once, now that 031 has somewhere to
-- put the links.
--
-- A separate migration rather than more lines on the end of 031, because 031
-- may already have run: appending to an applied migration is a change that
-- silently never executes, which is exactly what happened here in development.
-- The columns added in 031 start empty, and a row that was fetched successfully is not
-- looked at again for 24 hours, so without this the links would have been
-- missing on all 42,355 tokens already in the cache and the feature would have
-- looked broken on every token anybody had already opened.
--
-- Only the successful rows. A row carrying an error is already on the retry
-- backoff added in 030 and clearing its stamp would throw that away and send it
-- straight back at a gateway that just refused it.
--
-- Nothing is lost while they refill: `image_url` is read directly and is not
-- cleared here, so pictures keep rendering from the cache throughout. The
-- refetch is lazy, driven by tokens actually being looked at, so this is spread
-- over normal use rather than paid all at once.
UPDATE token_metadata
   SET offchain_fetched_at = NULL
 WHERE offchain_fetched_at IS NOT NULL
   AND offchain_error IS NULL;
