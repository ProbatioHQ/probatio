export const metadata = {
  title: 'Records, Probatio',
  description:
    'How a trade becomes a hash chain on Solana that nobody can revise, and how to check one without trusting this site.',
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

      <h2>Batches and the chain</h2>

      <p>
        Trades are gathered into a batch, and the batch is reduced to a single merkle root. Roots
        are then folded one at a time into a running value:
      </p>

      <pre>
        <code>accumulator = sha256(accumulator ‖ root ‖ leaves ‖ engine_version)</code>
      </pre>

      <p>
        That value is what lives on chain, thirty-two bytes covering every trade you have ever
        made, in order. A list would grow forever and cost rent forever; a single latest root
        would let history be quietly replaced.
      </p>

      <p>
        Because each value is computed from the one before it, changing an old trade changes
        every value after it. And those later values were already written to the chain at the
        time, publicly and with a timestamp. There is no version of the past that both matches
        the chain and differs from what happened.
      </p>

      <h2>What that stops</h2>

      <ul>
        <li>
          <strong>Us.</strong> The server cannot revise a trade after the fact. The key that
          writes commitments cannot either, it can only append.
        </li>
        <li>
          <strong>A stolen key.</strong> Somebody who took the committing key could append
          nonsense, and could not remove it or alter anything already there. That is detectable,
          it is not repairable, and a season it happened in would be void.
        </li>
        <li>
          <strong>A quiet edit.</strong> There is no such thing here. Every change to a record is
          an event on a public chain.
        </li>
      </ul>

      <h2>Checking one</h2>

      <p>
        <a href="/verify">The verify page</a> rebuilds every trade from its own recorded inputs,
        recomputes each batch root, folds the chain, and compares the result against Solana, in
        your browser, against an endpoint you choose. It does not ask this server whether the
        record is valid, because a server vouching for its own records is worth nothing.
      </p>

      <p>
        If this site were lying about a record, that page would say so. That is the only reason
        it exists.
      </p>

      <h2>What this does not cover</h2>

      <ul>
        <li>
          A trade that has not been committed yet cannot be checked. Commitments are batched, so
          recent trades may still be waiting, and the profile says how many are covered.
        </li>
        <li>
          The program that enforces all of this can still be replaced by whoever holds its
          upgrade authority. That is a public act, and{' '}
          <a href="/trust">the trust page</a> explains where it stands.
        </li>
        <li>
          The record proves what was traded and when. It does not prove the trader was skilled,
          which is what a season is for.
        </li>
      </ul>
    </>
  );
}
