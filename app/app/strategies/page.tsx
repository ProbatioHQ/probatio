import { StrategyBuilder } from '@/components/strategy-builder';

export const metadata = {
  title: 'Strategies, Probatio',
  description:
    'Write an algorithm, connect it to the simulator, and let it trade a season under the same fills and the same clock as everyone else. It lands on the same leaderboard.',
};

/**
 * Automated strategies, ranked beside everybody else.
 *
 * Two ways in and one engine. Rules in a form that this site runs on its own
 * clock, so a fortnight-long season does not require somebody to keep a laptop
 * awake; or a key, and a program of their own, for anything the form cannot say.
 * Both end at the same function a click ends at, take the same latency, are
 * quoted against a pool read twice, and write the same sealed record.
 *
 * There is no bot division and there is no bot handicap. A record made by a
 * program ranks against a record made by hand because there is nothing different
 * about how it was made.
 */

export default function StrategiesPage() {
  return (
    <main className="strategies">
      <div className="page-head">
        <h1>Strategies</h1>
        <p className="dim">
          Write an algorithm, connect it to the simulator, and it trades a season on live pump.fun
          prices through the same fill engine, on the same clock, against every human in that
          season. It lands on the same leaderboard they do. No separate bot division.
        </p>
      </div>

      <StrategyBuilder />

      <section className="panel strategy-panel">
        <div className="panel-head">
          <h2>What it cannot do</h2>
        </div>
        <ul className="strategy-limits">
          <li>
            <strong>It gets no faster lane.</strong> The same latency, the same slippage, the same
            price impact ceiling and the same suspension checks as a person clicking buy.
          </li>
          <li>
            <strong>It cannot outspend its balance.</strong> It can lose all of it, exactly like you
            can.
          </li>
          <li>
            <strong>It is not a second entrant.</strong> It trades the account you already entered
            with. If you want an entrant that is nothing but the algorithm, enter with a second
            wallet and give that one the key.
          </li>
          <li>
            <strong>Its orders are marked.</strong> Every trade records how it arrived, and your
            record shows it. Same board, same ranking, nothing hidden about how a row was made.
          </li>
        </ul>
      </section>
    </main>
  );
}
