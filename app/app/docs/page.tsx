export const metadata = {
  title: 'How it works, Probatio',
  description:
    'How fills are computed, how records are committed, and how a season is won. With the measured accuracy of the simulator.',
};

/* The four steps a trade goes through, which is the whole product in order. */
const HOW = [
  {
    step: 'Click',
    body: 'The pool reserves are read from the chain at that moment and quoted. The price you see is the price that exists.',
  },
  {
    step: 'Wait',
    body: 'Six hundred milliseconds pass. That is how long a real transaction takes to land, and the market keeps moving through it.',
  },
  {
    step: 'Fill',
    body: 'The reserves are read again and the trade fills against the market as it is by then. Sometimes worse. Sometimes rejected outright.',
  },
  {
    step: 'Commit',
    body: 'The trade is hashed, batched, and folded into a value on Solana. From that point nobody can revise it, including us.',
  },
];

/* The three objections worth answering before anybody asks them. */
const AGAINST = [
  {
    claim: 'Every paper trading app fills you at the price you clicked.',
    answer:
      'Which teaches the one habit that loses money for real: that size and speed are free. Here the price moves while your order is in flight, by exactly as much as it really moved.',
  },
  {
    claim: 'Every profit screenshot could have been made in a text editor.',
    answer:
      'So this one comes with a button. Records go to Solana as they happen, and the verify page rebuilds them in your browser against an RPC you choose. You never have to take our word for a number.',
  },
  {
    claim: 'Leaderboards get won by whoever runs the most wallets.',
    answer:
      'Entries are limited by funding source, every wallet is checked when it enters, and what the chain said about it is kept. Farming a record here costs more than earning one.',
  },
];

export default function DocsIndex() {
  return (
    <>
      <h1>How it works</h1>

      <p>
        Three things decide whether this is worth anybody&apos;s time: whether the fills are
        honest, whether the record can be checked, and whether the scoring is fair. Each has a
        page, and each says what it does not do as well as what it does.
      </p>

      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/trade</span>
          <h2>what happens when you trade</h2>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <ol className="flow">
            {HOW.map((entry, index) => (
              <li key={entry.step}>
                <span className="n">{String(index + 1).padStart(2, '0')}</span>
                <div className="flow-text">
                  <h3>{entry.step}</h3>
                  <p>{entry.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/why</span>
          <h2>why this is different</h2>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <dl className="objections">
            {AGAINST.map((entry) => (
              <div key={entry.claim}>
                <dt>{entry.claim}</dt>
                <dd>{entry.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

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

      <section className="panel">
        <h2>
          <a href="/docs/sdk">SDK</a>, <a href="/docs/cli">CLI</a> and{' '}
          <a href="/docs/mcp">MCP</a>
        </h2>
        <p>
          Read a record and check it against the chain yourself: in a few lines of TypeScript,
          from your terminal, or as tools an agent can call. The verification this site runs,
          shipped three ways, none of which trusts the server.
        </p>
      </section>

      <p>
        <a href="/trust">What you still have to trust</a> is the list of things none of this
        covers.
      </p>
    </>
  );
}
