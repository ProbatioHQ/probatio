import { BacktestPicker } from '@/components/backtest-picker';

export const metadata = {
  title: 'Backtest a rule, Probatio',
  description:
    'Replay an exit rule against the reserves a token really traded against, priced at a real exit rather than at the chart.',
};

/**
 * The address the backtest has.
 *
 * The panel already sits on every token page, which is where it gets used:
 * somebody is looking at a chart, wonders what a rule would have done, and it
 * is underneath. What it did not have was somewhere to point at. A feature that
 * cannot be linked from a roadmap, a post or a message is a feature nobody
 * finds, however well it works.
 *
 * Deliberately not in the navigation. It belongs with the tokens rather than
 * beside Season and Store, and somebody who wants it arrives from a token or
 * from a link rather than from a menu.
 */
export default function BacktestPage() {
  return (
    <main className="prose page-prose">
      <h1>Backtest a rule</h1>

      <p>
        Set a take profit and a stop, and this replays them against the pool a token really
        traded against, using the same engine that prices a live fill. Every exit is checked at
        what a real sell would have fetched out of the reserves at that moment, after your own
        order moved them and after the fee.
      </p>
      <p>
        Which is why it will sometimes tell you a rule never triggered even though the chart went
        straight through your level. A chart is a mid price, and nobody trades at the mid.
      </p>

      <BacktestPicker />
    </main>
  );
}
