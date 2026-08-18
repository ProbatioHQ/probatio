export const metadata = {
  title: 'Records, Probatio',
  description:
    'How a fill becomes a hash nobody can revise, and how to check one without trusting this site.',
};

export default function RecordsDoc() {
  return (
    <>
      <h1>Records</h1>

      <p>
        Every trading screenshot you have ever seen could have been made in a text editor. That
        is the problem this part solves, and it is the only reason a leaderboard here means
        anything.
      </p>

      <h2>What a trade commits to</h2>

      <p>
        Each fill is encoded into a fixed-width record and hashed. It carries the amounts, the
        fees, the slot it was clicked at, the slot it filled at, the engine that priced it, and
        the pool reserves it was quoted against.
      </p>

      <p>
        Those reserves are the part that matters. Without them, checking a trade would mean
        asking us for the one number the whole result depends on, which is exactly the trust the
        design is trying not to need. With them, anybody can recompute the fill from scratch.
      </p>

      <p>
        The encoding is fixed-width and fixed-order rather than JSON. Two JSON encoders can order
        keys differently and produce different bytes for the same trade, and a hash that changes
        with the encoder is a commitment to nothing.
      </p>

      <h2>The root over a record</h2>

      <p>
        Every fill in a record is a leaf, and the leaves are reduced to a single merkle root:
        thirty-two bytes standing for every trade you have made, in the order you made them.
      </p>

      <p>
        Order is part of the claim. A root is not a set, so the same fills in a different
        sequence produce a different root, and a record with one figure altered anywhere inside
        it produces a different one again.
      </p>

      <h2>What that catches</h2>

      <ul>
        <li>
          <strong>An edited fill.</strong> Change any field of a stored trade, a price, a fee, a
          reserve, and the hash recomputed from it stops matching the seal recorded beside it.
          The verify page names the trade.
        </li>
        <li>
          <strong>A reordered record.</strong> The root folds the fills in sequence, so moving
          one changes the root even though every individual seal still matches.
        </li>
        <li>
          <strong>A quiet correction.</strong> There is no way to improve a result after the
          fact without the arithmetic saying so.
        </li>
      </ul>

      <h2>Checking one</h2>

      <p>
        <a href="/verify">The verify page</a> asks this server for the inputs and the seals, then
        recomputes every hash in your browser and compares. It never asks whether the record is
        valid, because a server vouching for its own records is worth nothing.
      </p>

      <p>
        If this site had altered a record, that page would say so. That is the only reason it
        exists.
      </p>

      <h2>What this does not cover</h2>

      <ul>
        <li>
          A seal proves a fill has not been altered since it was recorded. It does not prove the
          price was right when it was recorded. The reserves stored with it are what make that
          checkable, afterwards rather than in advance.
        </li>
        <li>
          The records live in our database. <a href="/trust">The trust page</a> is the full list
          of what that still asks you to take on faith.
        </li>
        <li>
          The record proves what was traded and when. It does not prove the trader was skilled,
          which is what a season is for.
        </li>
      </ul>
    </>
  );
}
