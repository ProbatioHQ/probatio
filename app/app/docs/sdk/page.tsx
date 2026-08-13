export const metadata = {
  title: 'SDK, Probatio',
  description:
    'Read a Probatio record and check it against the chain yourself, in a few lines of TypeScript. The verification the site runs, as a library.',
};

export default function SdkDocs() {
  return (
    <>
      <h1>SDK</h1>

      <p>
        The point of Probatio is that a record does not need Probatio to be believed.{' '}
        <code>@probatio/sdk</code> is that as a library. It fetches the trades a trader
        committed, rebuilds their hashes, folds them into an accumulator, and compares it to
        the one Solana holds, at an address derived from constants inside the package, over an
        RPC you choose. A <code>verified: true</code> never comes from a server&apos;s say-so.
      </p>

      <pre>
        <code>{`npm install @probatio/sdk`}</code>
      </pre>

      <section className="panel">
        <h2>Verify a record</h2>
        <p>
          The flagship call. Give it a wallet and an RPC endpoint, and it returns whether the
          record checks out, along with every step it took to decide.
        </p>
        <pre>
          <code>{`import { Probatio } from '@probatio/sdk';

const probatio = new Probatio({
  rpc: 'https://api.mainnet-beta.solana.com',
});

const result = await probatio.verifyRecord(wallet);

result.verified;             // true only when the chain holds what these trades produce
result.computedAccumulator;  // what the committed trades fold to
result.onChainAccumulator;   // what Solana actually holds
result.tradeCount;           // how many trades were checked
result.checks;               // each step: roots rebuilt, membership, chain fold, on-chain`}</code>
        </pre>
        <p>
          Every check must pass for <code>verified</code> to be true: the trades rebuild their
          roots, the roots fold to the accumulator the record claims, and that accumulator is
          the one on chain. A season can be named with{' '}
          <code>verifyRecord(wallet, {'{'} season: 1 {'}'})</code>; without it the latest
          committed season is used.
        </p>
      </section>

      <section className="panel">
        <h2>Read the record</h2>
        <p>
          The public data behind a trader and a season, with no wallet and no signing.
        </p>
        <pre>
          <code>{`const record = await probatio.getRecord(wallet);   // name, seasons, where to prove it
const board  = await probatio.getStandings({ season: 1 });
const proof  = await probatio.getProof(wallet);    // the raw inputs verifyRecord checks`}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>Why it does not trust us</h2>
        <p>
          The SDK reads the trades from a Probatio instance, because it has to get the data
          somewhere. It does not read the <em>verdict</em> from anywhere. The record&apos;s
          on-chain address is derived from the program id and seeds shipped in the package, the
          accumulator is fetched from the RPC you pass, and the comparison happens on your
          machine. An instance that served a record it never committed, or lied about the
          numbers, fails <code>verifyRecord</code> rather than being believed by it.
        </p>
      </section>

      <section className="panel">
        <h2>Standalone and low-level</h2>
        <p>
          Every method exists as a plain function for callers who would rather not hold an
          instance, and the primitives the verification is built from are re-exported for
          callers who already have the data.
        </p>
        <pre>
          <code>{`import {
  verifyRecord, getProof, getRecord, getStandings,   // standalone
  hashLeaf, buildTree, verifyProof, extendChain,      // primitives, from @probatio/commit
} from '@probatio/sdk';`}</code>
        </pre>
      </section>

      <p>
        A <a href="https://github.com/ProbatioHQ/probatio">command-line tool</a> and an MCP
        server for agents to vet or back a trader on proof rather than promises are built on
        this same core.
      </p>
    </>
  );
}
