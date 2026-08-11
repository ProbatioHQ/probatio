import type { Metadata } from 'next';
import { LaunchFeedList } from '@/components/launch-feed';

export const metadata: Metadata = {
  title: 'Terminal, Probatio',
  description:
    'Every pump.fun launch as it happens: what just launched, what is about to bond, and what has graduated.',
};

/**
 * The terminal.
 *
 * The front page carries a preview because somebody arriving needs to see the
 * thing is alive. This is where you actually sit: wider than the rest of the
 * site, more rows, filters that persist, and a pause for when you want to read
 * a row instead of watching it move.
 *
 * Deliberately not behind a wallet. Discovery is what a visitor does before
 * they have one, and this is the page worth arriving at.
 */
export default function FeedPage() {
  return (
    <main className="wide">
      <div className="page-head">
        <h1>Terminal</h1>
        <p className="dim">
          Every pump.fun launch as it happens. Pick anything and trade it with practice money against
          the prices, the liquidity and the fees are the real ones.
        </p>
      </div>

      <LaunchFeedList variant="terminal" />

      <p className="dim" style={{ fontSize: 13 }}>
        Market caps are shown in dollars for readability and are display only. Everything this
        site decides, whether a fill, a balance, a ranking or a payout, is counted in lamports and never
        touches an exchange rate. <a href="/docs/fills">How the fills work</a>.
      </p>
    </main>
  );
}
