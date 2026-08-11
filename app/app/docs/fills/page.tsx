export const metadata = {
  title: 'Fills, Probatio',
  description:
    'How a simulated fill is computed against live pool reserves, with real slippage and real delay. And the measured error against real bonding-curve trades: 0 bps.',
};

export default function FillsDoc() {
  return (
    <>
      <h1>Fills</h1>

      <p>
        A paper trading tool that fills you at the price you clicked is a toy. It teaches the one
        habit that loses money in the market it is pretending to be, that size is free and speed
        is free, and then tells you that you are good at trading.
      </p>

      <h2>What happens when you click</h2>

      <ol>
        <li>The pool&apos;s reserves are read from the chain at that moment, and quoted.</li>
        <li>
          Nothing happens for 600 milliseconds. This is the wait a real transaction takes to
          land, and it is not simulated with a random number.
        </li>
        <li>
          The reserves are read <em>again</em>, and the fill is computed against the state the
          market is actually in by then.
        </li>
      </ol>

      <p>
        So the price moves under you while you wait, exactly as much as it really moved, because
        it is the same market. A trade into a token that is running gets a worse price than the
        one on screen. That is the point.
      </p>

      <h2>What can go wrong, and does</h2>

      <p>
        A trade can be rejected outright, for the same reasons a real one is: slippage past your
        tolerance, price impact past the season&apos;s limit, no liquidity, a size too small to
        matter, or a market that graduated to a different venue while you were waiting. A
        rejected trade is a real outcome and it is recorded as one.
      </p>

      <p>
        Fees are the real ones. On a bonding curve that is 125 basis points, split 95 to the
        protocol and 30 to the creator. Your cost basis includes them, because a position is only
        in profit once it has covered what it cost to open.
      </p>

      <h2>How accurate is it</h2>

      <p>
        The engine is replayed against trades that actually happened. Real swaps are pulled from
        the chain, ordered by slot and by position within the transaction, and each one is
        re-quoted from the reserves that stood immediately before it. The difference between what
        the engine produces and what the market produced is the error.
      </p>

      <div className="panel" role="group" aria-label="Measured accuracy">
        <dl>
          <dt>Measured</dt>
          <dd className="mono">11 August 2026</dd>
          <dt>Samples</dt>
          <dd className="mono">129 real fills</dd>
          <dt>Median error</dt>
          <dd className="mono gain">0 bps</dd>
          <dt>95th percentile</dt>
          <dd className="mono gain">0 bps</dd>
          <dt>Worst case</dt>
          <dd className="mono gain">0 bps</dd>
          <dt>Exact matches</dt>
          <dd className="mono gain">129 of 129</dd>
        </dl>
      </div>

      <p>
        Not close. Identical, to the lamport, on every sample.
      </p>

      <p>
        A pair is only scored when the reserves prove the two trades were consecutive, that
        nothing happened in between that we did not see. In that run, 91 of 222 events were
        skipped for that reason. Throwing away most of the data is what makes the number mean
        anything: a sample that quietly included gaps would be measuring our bookkeeping rather
        than the engine.
      </p>

      <p>
        The date matters because the harness reads live history, so the sample grows as those
        tokens keep trading. Rerunning it will not reproduce these counts exactly, and a page
        that stated them as though it would was inviting the reader to think the number had been
        rounded in our favour. The counts move; the errors have not.
      </p>

      <p>
        <strong>After graduation.</strong> Every sample above is a curve fill, because that
        harness walks a token&rsquo;s bonding curve and stops where the curve does. There is now
        a second one for PumpSwap, where a token trades once it graduates. On a liquid graduated
        coin it reproduces real swaps at 0 bps — median, 95th percentile and worst case — across
        buys and sells, most of them identical to the smallest unit and the rest within one of
        it.
      </p>

      <p>
        It is not yet a claim about every graduated coin, and the exception is specific rather
        than vague. Some pools carry accrued state in a part of their account we do not decode,
        and on one of those the engine prices consistently 2.8 times away from the market — 2.8
        on buys and its reciprocal on sells. A fixed factor, not a drift, which is what a wrong
        reserve looks like rather than wrong arithmetic. Where those bytes are zero the engine is
        exact; where they are set it is not, and the likeliest reading is that such a pool prices
        against its own accounting rather than against whatever is sitting in its vaults.
      </p>

      <p>
        So: measured exact on the graduated coins that can be checked, and knowingly unverified
        on the ones that carry that state. Saying which is which is the point of having the
        harness at all. Both of them are in the repository and run against mainnet.
      </p>

      <p>
        <strong>What a graduated token costs.</strong> PumpSwap publishes its fee schedule in an
        account on chain, and that is where these numbers come from rather than from anything
        written in this repository: 0.20% to the pool&rsquo;s liquidity providers, 0.05% protocol,
        0.05% to the coin&rsquo;s creator. Thirty basis points, read live and re-read if it
        changes.
      </p>

      <p>
        Until recently the engine charged 1.25% here — the bonding curve&rsquo;s rate, copied
        across and never checked, because the harness that checks fees only ever walked the curve.
        Every migrated coin was four times too expensive to trade, and since a season ranks curve
        traders and migrated-coin traders against each other for the same prize, that was a
        handicap on one of them rather than only an inaccuracy. It is measured now, two
        independent ways: the published schedule sums to 30 bps, and replaying real buys off the
        chain recovers 29.
      </p>

      <h2>Check it yourself</h2>

      <p>The harness is in the repository and runs against mainnet:</p>

      <pre>
        <code>RPC_VALIDATION=1 npx vitest run packages/validation/test/mainnet.test.ts{'\n'}npx tsx scripts/replay-pumpswap.mts &lt;mint&gt;</code>
      </pre>

      <p>
        It reads live trades, so it measures whatever the market did today rather than a fixture
        chosen to look good. The sample differs on every run and the error does not.
      </p>

      <h2>What this does not cover</h2>

      <ul>
        <li>
          It measures the pricing, not the delay. Whether 600 milliseconds is the right wait is a
          judgement; the fee and curve arithmetic is not.
        </li>
        <li>
          A token with no readable pool cannot be quoted at all, and trading is refused rather
          than estimated.
        </li>
        <li>
          Your order never affects the real market, so it never moves the price for anyone else.
          At the sizes a practice balance allows, that difference is small; at large size it
          would not be.
        </li>
      </ul>
    </>
  );
}
