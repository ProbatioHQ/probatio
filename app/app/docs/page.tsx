export const metadata = {
  title: 'How it works, Probatio',
  description:
    'How fills are computed, how records are committed, and how a season is won. With the measured accuracy of the simulator.',
};

export default function DocsIndex() {
  return (
    <>
      <h1>How it works</h1>

      <p>
        Three things decide whether this is worth anybody&apos;s time: whether the fills are
        honest, whether the record can be checked, and whether the scoring is fair. Each has a
        page, and each says what it does not do as well as what it does.
      </p>

      <section className="panel">
        <h2>
          <a href="/docs/fills">Fills</a>
        </h2>
        <p>
          What happens between clicking and filling, and why a trade here can lose money the way
          a real one does. Includes the measured accuracy against real trades, and the command
          to measure it yourself.
        </p>
      </section>

      <section className="panel">
        <h2>
          <a href="/docs/records">Records</a>
        </h2>
        <p>
          How a trade becomes a hash, a batch, and a value on Solana that nobody can revise , 
          and how to check one without asking us anything.
        </p>
      </section>

      <section className="panel">
        <h2>
          <a href="/docs/scoring">Scoring</a>
        </h2>
        <p>
          How a season is won, how ties are broken, and why the clever risk-adjusted formula was
          removed rather than kept.
        </p>
      </section>

      <p>
        <a href="/trust">What you still have to trust</a> is the list of things none of this
        covers.
      </p>
    </>
  );
}
