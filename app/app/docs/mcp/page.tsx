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
        record, and check it against Solana. It speaks over stdio and exposes four tools built on
        the same core, so the verdict an agent sees is one it could have recomputed itself.
      </p>

      <section className="panel">
        <h2>Connect it</h2>
        <p>
          Point an MCP client at the <code>probatio-mcp</code> binary. The RPC it verifies
          against is read from the environment, so a call does not have to carry one.
        </p>
        <pre>
          <code>{`{
  "mcpServers": {
    "probatio": {
      "command": "npx",
      "args": ["-y", "@probatio/mcp"],
      "env": {
        "PROBATIO_RPC": "https://api.mainnet-beta.solana.com"
      }
    }
  }
}`}</code>
        </pre>
        <p>
          <code>PROBATIO_RPC</code> is the endpoint <code>verify_record</code> checks against when
          a call omits one; <code>PROBATIO_API</code> points at a specific instance, and defaults
          to the hosted one.
        </p>
      </section>

      <section className="panel">
        <h2>The tools</h2>
        <p>Four, each a plain wrapper over the SDK.</p>
        <pre>
          <code>{`verify_record   { wallet, rpc?, season? }
    Rebuild a trader's committed trades, fold the accumulator, and
    compare it to the one on chain. Returns verified plus every check.

get_record      { wallet }
    The public record: name, the seasons traded, and where to prove it.

get_standings   { season?, limit? }
    A season's standings, or the current one when none is named.

get_proof       { wallet, season? }
    The raw inputs verify_record recomputes from: every committed
    trade, its batch, and the roots.`}</code>
        </pre>
        <p>
          <code>verify_record</code> is the one that matters. It needs an RPC, from the call or
          from <code>PROBATIO_RPC</code>, and it returns the verdict along with each step, so an
          agent can show its work rather than assert a result.
        </p>
      </section>

      <section className="panel">
        <h2>Why an agent can trust it</h2>
        <p>
          For the same reason a person can. The server reads a trader&apos;s trades from a
          Probatio instance, because the data lives somewhere, but it does not read the{' '}
          <em>verdict</em> from anywhere. The record&apos;s on-chain address is derived from
          constants in the package, the accumulator is fetched from the RPC, and the comparison
          happens in the server. An instance that served a record it never committed fails{' '}
          <code>verify_record</code> rather than being believed by it.
        </p>
      </section>

      <p>
        The server is a transport over <a href="/docs/sdk">the SDK</a>; the same core is a{' '}
        <a href="/docs/cli">command</a> for people.
      </p>
    </>
  );
}
