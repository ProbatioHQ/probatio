export const metadata = {
  title: 'Trading API, Probatio',
  description:
    'Place orders from your own program. Three endpoints, one key, and the same fill engine a click goes through.',
};

/**
 * How to connect a program.
 *
 * Written for somebody who wants to trade from their own code and has no
 * interest in reading about the engine first. Three endpoints, one key, a
 * worked example short enough to copy in one go, and an honest account of the
 * two things that surprise people: the latency is real and the daily cap exists.
 */

const BOT = `const KEY  = process.env.PROBATIO_KEY;          // from /strategies
const BASE = 'https://probatiotrade.com/api/v1';

const call = async (path, init = {}) =>
  (await fetch(BASE + path, {
    ...init,
    headers: { authorization: \`Bearer \${KEY}\`, 'content-type': 'application/json' },
  })).json();

// Buy the first fresh, liquid launch we are not already holding.
const me = await call('/account');
const { tokens } = await call('/tokens?limit=50');
const held = new Set(me.positions.map((p) => p.mint));

for (const token of tokens) {
  if (held.has(token.mint)) continue;
  if (token.graduated) continue;
  if (token.ageSeconds > 90) continue;
  if (BigInt(token.liquidityLamports ?? '0') < 20_000_000_000n) continue;

  const fill = await call('/orders', {
    method: 'POST',
    body: JSON.stringify({
      mint: token.mint,
      side: 'buy',
      size: '250000000',            // 0.25 SOL, in lamports, as a string
    }),
  });

  console.log(fill.status, fill.filled?.solAmount, fill.filled?.priceImpactBps + 'bps');
  break;
}`;

const SELL = `// Sell all of it. Sizes are token base units on a sell, lamports on a buy.
const [position] = (await call('/account')).positions;

await call('/orders', {
  method: 'POST',
  body: JSON.stringify({
    mint: position.mint,
    side: 'sell',
    size: position.tokenAmount,
  }),
});`;

export default function ApiDocsPage() {
  return (
    <main className="docs">
      <div className="page-head">
        <h1>Trading API</h1>
        <p className="dim">
          Place orders from your own program, in any language. One key, three endpoints, and the
          same fill engine a click on this site goes through. A record made this way ranks beside a
          record made by hand, because there is nothing different about how it was made.
        </p>
      </div>

      <section className="panel docs-panel">
        <div className="panel-head">
          <h2>Get a key</h2>
        </div>
        <p className="dim">
          Mint one on <a href="/strategies">the strategies page</a>. It is shown once and only its
          hash is stored, so it cannot be recovered. Send it on every request:
        </p>
        <pre className="docs-code">
          <code>Authorization: Bearer pk_live_...</code>
        </pre>
        <p className="dim">
          Never in a query string. A key in a URL ends up in access logs, in browser history and in
          the referrer sent to the next site you visit.
        </p>
      </section>

      <section className="panel docs-panel">
        <div className="panel-head">
          <h2>The endpoints</h2>
        </div>
        <dl className="docs-endpoints">
          <dt>
            <code>POST /api/v1/orders</code>
          </dt>
          <dd>
            <code>{'{ mint, side: "buy" | "sell", size, slippageBps? }'}</code>. Size is lamports on
            a buy and token base units on a sell, always as a string, because a JSON number cannot
            hold a lamport balance without rounding it. Answers <code>filled</code> or{' '}
            <code>rejected</code>, and a rejection is a real outcome at 200: a reverted transaction
            is not an error.
          </dd>

          <dt>
            <code>GET /api/v1/account</code>
          </dt>
          <dd>
            Balance, open positions, the season you are in, and how much of today’s allowance is
            left. Positions come back marked at the last known price, which is what a chart says
            and not what a sell would fetch. Do not size an exit off it.
          </dd>

          <dt>
            <code>GET /api/v1/tokens</code>
          </dt>
          <dd>
            What there is to trade, with age, depth and market cap where they are known. Nothing
            here reads the chain, so it can be polled freely.
          </dd>
        </dl>
      </section>

      <section className="panel docs-panel">
        <div className="panel-head">
          <h2>A whole bot</h2>
        </div>
        <p className="dim">
          Save it as <code>bot.mjs</code> and run it with <code>node bot.mjs</code> on Node 18 or
          newer. The extension matters: this uses await at the top level, which a plain{' '}
          <code>.js</code> file is not allowed to do unless the project is already a module.
        </p>
        <pre className="docs-code">
          <code>{BOT}</code>
        </pre>
        <p className="dim">And to close it:</p>
        <pre className="docs-code">
          <code>{SELL}</code>
        </pre>
      </section>

      <section className="panel docs-panel">
        <div className="panel-head">
          <h2>Three things that surprise people</h2>
        </div>
        <ul className="strategy-limits">
          <li>
            <strong>The latency is real.</strong> Your order reads the pool, waits out the season’s
            delay, reads again, and is quoted against what the pool actually became. It is not a
            simulated pause over one reading. Sometimes the price moves against you in that window,
            and sometimes the order fails. That is the whole point of this simulator.
          </li>
          <li>
            <strong>There is a daily cap.</strong> Two hundred automated orders a day, across this
            API and any hosted strategy together. Every fill reads the chain twice, so this is what
            stops one runaway loop spending a month of the site’s allowance in a day. Past it you
            get a 429 that says how many you have used.
          </li>
          <li>
            <strong>Your program has to be running.</strong> If your machine sleeps, your bot stops.
            If that is a problem, write the same rules in{' '}
            <a href="/strategies">the form</a> instead and this site runs them for the whole season
            with your laptop shut.
          </li>
        </ul>
      </section>

      <section className="panel docs-panel">
        <div className="panel-head">
          <h2>What a key can and cannot do</h2>
        </div>
        <p className="dim">
          It places orders on the account you already entered the season with. It is not a second
          entrant and pays no second entry. It cannot mint another key, cannot move real money,
          cannot read anything but your own account, and stops working the instant you revoke it.
        </p>
        <p className="dim">
          If you want an entrant that is nothing but the algorithm, with no human hands on it at
          all, enter with a second wallet and give that one the key.
        </p>
      </section>
    </main>
  );
}
