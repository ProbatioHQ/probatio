export const metadata = {
  title: 'CLI, Probatio',
  description:
    'Verify a Probatio record and read the public data from your terminal. The verification the site runs, as a command that exits non-zero when a record does not hold.',
};

export default function CliDocs() {
  return (
    <>
      <h1>CLI</h1>

      <p>
        Checking a record from a terminal, against an RPC you name, is the plainest form of
        &quot;do not trust us, check&quot;. <code>@probatio/cli</code> is the SDK as a command.
        It reads the trades a trader committed, rebuilds them, and compares the result to the
        accumulator on Solana. Nothing about the verdict comes from a server.
      </p>

      <pre>
        <code>{`npx @probatio/cli verify <wallet> --rpc https://api.mainnet-beta.solana.com`}</code>
      </pre>

      <section className="panel">
        <h2>Verify a record</h2>
        <p>
          The flagship command. It prints each check, then sets its exit code to the verdict, so
          it drops straight into a script or a CI step without anything having to parse its
          output.
        </p>
        <pre>
          <code>{`$ probatio verify 7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr \\
    --rpc https://api.mainnet-beta.solana.com

  PASS  roots rebuilt: 3 batch root(s) recomputed from the trades
  PASS  membership: every trade proven under its batch root
  PASS  chain fold: roots fold to the claimed accumulator
  PASS  on-chain: the account holds that accumulator

VERIFIED  ace in season 1, 9 trade(s) checked`}</code>
        </pre>
        <p>
          <code>verify</code> exits <code>0</code> when the record holds against the chain,{' '}
          <code>1</code> when it does not, and <code>2</code> on a usage error. So a guard is
          just:
        </p>
        <pre>
          <code>{`probatio verify "$WALLET" --rpc "$RPC" || echo "record did not check out"`}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>Read the record and the standings</h2>
        <p>The public data behind a trader and a season, no wallet and no signing.</p>
        <pre>
          <code>{`probatio record <wallet>            # name, and the seasons they traded
probatio standings                 # the current ranked season's board
probatio proof <wallet>            # the raw inputs verify recomputes from, as JSON`}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>Options</h2>
        <p>A small, shared set of flags.</p>
        <pre>
          <code>{`--rpc <url>     Solana RPC endpoint to check against   (verify)
--season <n>    a specific season ordinal, default the latest committed   (verify, proof)
--limit <n>     how many standings to return   (standings)
--api <url>     a Probatio instance, default https://probatio.app
--json          print the raw JSON result instead of a summary`}</code>
        </pre>
        <p>
          <code>--api</code> is how you point the command at your own instance;{' '}
          <code>--rpc</code> is the endpoint it checks that instance against. The two are
          separate on purpose: the data comes from one, the truth from the other.
        </p>
      </section>

      <p>
        The command is a thin shell over <a href="/docs/sdk">the SDK</a>, and an{' '}
        <a href="/docs/mcp">MCP server</a> exposes the same core to agents.
      </p>
    </>
  );
}
