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
        <strong>What this does not cover.</strong> The harness follows a token&rsquo;s bonding
        curve, so every sample above is a curve fill. Once a token graduates it trades on
        PumpSwap, and those fills are not measured here — the engine prices them from the pool
        reserves the same way, but &ldquo;the same way&rdquo; is an argument and this page is
        supposed to contain the opposite of one. Treat the number as what it is: the curve,
        measured.
      </p>

      <p>
        <strong>And a graduated token costs you more here than it would on the market.</strong>{' '}
        PumpSwap&rsquo;s fee slides down as a coin grows, from about 1.25% on a fresh graduate
        toward 0.30% once it is established. This engine charges every graduated token the top of
        that range. Measured against real buys on a large graduated coin, the market took about
        0.3% and we take 1.25% — four times too much.
      </p>

      <p>
        It is left that way on purpose, because the alternative is charging some traders less than
        the market really would, and a simulator that flatters you is worth nothing. But it is a
        real cost and you should know it: if you trade migrated coins you are being handicapped
        against someone trading the curve, where the fee is exact to the lamport. Fixing it
        properly means reading the live fee schedule rather than picking a better constant.
      </p>

      <h2>Check it yourself</h2>

      <p>The harness is in the repository and runs against mainnet:</p>

      <pre>
        <code>RPC_VALIDATION=1 npx vitest run packages/validation/test/mainnet.test.ts</code>
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
