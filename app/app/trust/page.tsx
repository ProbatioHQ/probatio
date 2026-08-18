export const metadata = { title: 'What you have to trust, Probatio' };

/**
 * The page that argues against the product.
 *
 * Every system like this has a list of things you still have to take on faith,
 * and most of them are written by the people asking for the faith. Putting it
 * on its own page, linked from the first sentence on the site, is the only
 * version of this worth publishing.
 *
 * It used to be mostly about a program that was never deployed: what its
 * upgrade authority could do, why it had not been burned, what would happen
 * when it was. All of that argued about something that does not run, which made
 * the page long, gloomy and about the wrong subject. It covers what the site
 * actually does now, which is a shorter and more useful list.
 */
export default function TrustPage() {
  return (
    <main className="prose page-prose">
      <h1>What you have to trust</h1>

      <p>
        Every fill is sealed with a hash the moment it lands, and you can recompute that hash
        yourself. That is the part you do not have to take on trust. Here is the part you do.
      </p>

      <h2>The seal covers the fill, not the price it was given</h2>
      <p>
        A seal proves a recorded trade has not been altered since it was recorded. It cannot
        prove the price was right in the first place. What makes that checkable is separate: the
        reserves a fill was priced from are recorded with it, so the arithmetic can be repeated
        afterwards and a wrong fill can be caught. Caught after the fact, not prevented in
        advance.
      </p>

      <h2>Prices are read by us</h2>
      <p>
        The prices are real and they come from the same pools everybody else trades against. But
        we are the ones reading them, and a bad read is possible. Two things reduce it: the
        reserves behind every fill are stored, and a watchdog compares what the engine believes
        against what the market says and suspends trading when they diverge.
      </p>

      <h2>The balances are ours</h2>
      <p>
        Your practice balance lives in our database. There is no version of it you hold. If this
        server lost its data tomorrow, your record would be gone with it, and the honest answer
        is that snapshots are the only thing standing between you and that.
      </p>

      <h2>Nobody outside has reviewed this</h2>
      <p>
        The engine has been reviewed by the person who wrote it and by nobody else. No outside
        audit, no fuzzing, no formal analysis. The source is public, which is not the same thing
        as having been read.
      </p>

      <h2>Display names</h2>
      <p>
        Names on the leaderboard are moderated by us. Removing one changes no record and no
        balance, which is precisely why moderating them is safe to do.
      </p>

      <p>
        <a href="/verify">Check a record yourself</a>
      </p>
    </main>
  );
}
