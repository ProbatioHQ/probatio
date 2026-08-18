export const metadata = {
  title: 'SDK, Probatio',
  description:
    'Read a Probatio record and check its hashes yourself, in a few lines of TypeScript. The verification the site runs, as a library.',
};

export default function SdkDocs() {
  return (
    <>
      <h1>SDK</h1>

      <p>
        The point of Probatio is that a record does not need Probatio to be believed.{' '}
        <code>@probatio/sdk</code> is that as a library. It fetches the figures every fill was
        priced from, rehashes each one, and compares against the seal recorded beside it. A{' '}
        <code>verified: true</code> never comes from a server&apos;s say-so.
      </p>

      <pre>
        <code>{`npm install @probatio/sdk`}</code>
      </pre>

      <section className="panel">
        <h2>Verify a record</h2>
        <p>
          The flagship call. Give it a wallet and it returns whether the record checks out, along
          with every step it took to decide. It needs no endpoint and no key: the checking is
          arithmetic, and the only network call is fetching the record.
        </p>
        <pre>
          <code>{`import { Probatio } from '@probatio/sdk';

const probatio = new Probatio();

const result = await probatio.verifyRecord(wallet);

result.verified;    // true only when every fill matches the seal recorded with it
result.root;        // one hash standing for the whole record, in order
result.broken;      // the fills that disagree, by sequence, empty when none do
result.tradeCount;  // how many fills were checked
result.checks;      // each step, with the detail behind it`}</code>
        </pre>
        <p>
          Every check must pass for <code>verified</code> to be true: each fill rehashes to its
          seal, and each fill proves membership of the record&apos;s root. A season can be named
          with <code>verifyRecord(wallet, {'{'} season: 1 {'}'})</code>; without it the
          trader&apos;s latest is used.
        </p>
      </section>

      <section className="panel">
        <h2>Read the record</h2>
        <p>
          The public data behind a trader and a season, with no wallet and no signing.
        </p>
        <pre>
          <code>{`const record = await probatio.getRecord(wallet);   // name, seasons, where to prove it
const board  = await probatio.getStandings();      // the current ranked season
const season = await probatio.getSeason();         // pot, payouts, ruleset hash to check
const proof  = await probatio.getProof(wallet);    // the raw inputs verifyRecord checks`}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>Why it does not trust us</h2>
        <p>
          The SDK reads the fills from a Probatio instance, because it has to get the data
          somewhere. It does not read the <em>verdict</em> from anywhere. The hashing is the
          same open-source function the engine seals with, it runs on your machine, and it runs
          over figures the instance handed you. An instance that altered a stored fill has to
          hand you the altered figures, which no longer produce the seal beside them, so it
          fails <code>verifyRecord</code> rather than being believed by it.
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
        A <a href="/docs/cli">command-line tool</a> and an <a href="/docs/mcp">MCP server</a>{' '}
        for agents to vet or back a trader on proof rather than promises are built on this same
        core.
      </p>
    </>
  );
}
