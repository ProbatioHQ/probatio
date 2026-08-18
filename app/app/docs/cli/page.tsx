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
        Checking a record from a terminal is the plainest form of &quot;do not trust us,
        check&quot;. <code>@probatio/cli</code> is the SDK as a command. It reads the figures
        every fill was priced from, rehashes each one, and compares against the seal recorded
        beside it. The verdict is arithmetic done on your machine.
      </p>

      <pre>
        <code>{`npx @probatio/cli verify <wallet>`}</code>
      </pre>

      <section className="panel">
        <h2>Verify a record</h2>
        <p>
          The flagship command. It prints each check, then sets its exit code to the verdict, so
          it drops straight into a script or a CI step without anything having to parse its
          output.
        </p>
        <pre>
          <code>{`$ probatio verify 7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr

  PASS  Seals: all 9 fills rehash to exactly the seal recorded with them
  PASS  Membership: every fill proves it belongs to the record, in the order it was made

VERIFIED  7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr, 9 fill(s) checked
ROOT      4f2c9a1d8b3e57069c4a1f8d2e6b03571a9c4e8f2d6b0357194c8ea3f7d20b6c1`}</code>
        </pre>
        <p>
          A record with a fill that was edited after it was sealed fails, and the failing fill is
          named rather than the whole record:
        </p>
        <pre>
          <code>{`  FAIL  Seals: 1 of 9 fills do not match their seal
  FAIL  Fill 4: its figures hash to 91c04ae7f2b6…, but 3d8f1c6b0a45… was recorded

NOT VERIFIED  7xKXtg…, fill(s) 4 do not match their seal`}</code>
        </pre>
        <p>
          <code>verify</code> exits <code>0</code> when every fill matches its seal,{' '}
          <code>1</code> when one does not, and <code>2</code> on a usage error. So a guard is
          just:
        </p>
        <pre>
          <code>{`probatio verify "$WALLET" || echo "record did not check out"`}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>Read the record and the standings</h2>
        <p>The public data behind a trader and a season, no wallet and no signing.</p>
        <pre>
          <code>{`probatio record <wallet>            # name, and the seasons they traded
probatio standings                 # the current ranked season's board
probatio season                    # pot, payouts, and the ruleset-hash check
probatio proof <wallet>            # the raw inputs verify recomputes from, as JSON`}</code>
        </pre>
      </section>

      <section className="panel">
        <h2>Options</h2>
        <p>A small, shared set of flags.</p>
        <pre>
          <code>{`--season <n>    a specific season ordinal, default the trader's latest   (verify, proof)
--limit <n>     how many standings to return   (standings)
--api <url>     a Probatio instance, default https://probatiotrade.com
--json          print the raw JSON result instead of a summary`}</code>
        </pre>
        <p>
          <code>--api</code> is how you point the command at your own instance. There is no
          endpoint flag: verification needs nothing beyond the record itself, so the only
          network call is fetching it.
        </p>
      </section>

      <p>
        The command is a thin shell over <a href="/docs/sdk">the SDK</a>, and an{' '}
        <a href="/docs/mcp">MCP server</a> exposes the same core to agents.
      </p>
    </>
  );
}
