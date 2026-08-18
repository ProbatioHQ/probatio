export const metadata = {
  title: 'MCP, Probatio',
  description:
    'An MCP server so an agent can read and verify a Probatio record on proof rather than promises. The verification the site runs, exposed as tools.',
};

export default function McpDocs() {
  return (
    <>
      <h1>MCP</h1>

      <p>
        An agent that wants to vet or back a trader should not have to take a leaderboard&apos;s
        word for it. <code>@probatio/mcp</code> gives it the same reach the SDK has: read a
        record, and check it against Solana. It speaks over stdio and exposes five tools built on
        the same core, so the verdict an agent sees is one it could have recomputed itself.
      </p>

      <section className="panel">
        <h2>Connect it</h2>
        <p>
          Point an MCP client at the <code>probatio-mcp</code> binary. Nothing else is needed:
          verification is arithmetic, so there is no endpoint to configure.
        </p>
        <pre>
          <code>{`{
  "mcpServers": {
    "probatio": {
      "command": "npx",
      "args": ["-y", "@probatio/mcp"]
    }
  }
}`}</code>
        </pre>
        <p>
          <code>PROBATIO_API</code> points at a specific instance and defaults to the hosted one.
          It is the only setting there is.
        </p>
      </section>

      <section className="panel">
        <h2>The tools</h2>
        <p>Five, each a plain wrapper over the SDK.</p>
        <pre>
          <code>{`verify_record   { wallet, season? }
    Rebuild every fill from the figures it was priced from and compare
    each hash to the seal recorded with it. Returns verified, the record
    root, any fills that disagree, and every check.

get_record      { wallet }
    The public record: name, the seasons traded, and where to prove it.

get_standings   { limit? }
    The standings of the current ranked season, or null when none runs.

get_season      { }
    The current ranked season: status, pot, projected payouts, and the
    ruleset hash recorded for the season versus the one recomputed now.

get_proof       { wallet, season? }
    The raw inputs verify_record recomputes from: every fill, the
    figures it was priced from, and the seal written with it.`}</code>
        </pre>
        <p>
          <code>verify_record</code> is the one that matters. It needs nothing but a wallet,
          and it returns the verdict along with each step, so an agent can show its work rather
          than assert a result.
        </p>
      </section>

      <section className="panel">
        <h2>Why an agent can trust it</h2>
        <p>
          For the same reason a person can. The server reads a trader&apos;s fills from a
          Probatio instance, because the data lives somewhere, but it does not read the{' '}
          <em>verdict</em> from anywhere. It rehashes every fill with the same open-source
          function the engine seals with, and compares. An instance that altered a stored fill
          has to hand over the altered figures, which no longer produce the seal beside them, so
          it fails <code>verify_record</code> rather than being believed by it.
        </p>
      </section>

      <p>
        The server is a transport over <a href="/docs/sdk">the SDK</a>; the same core is a{' '}
        <a href="/docs/cli">command</a> for people.
      </p>
    </>
  );
}
