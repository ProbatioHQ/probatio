import type { Metadata } from 'next';
import { SeasonBoard } from '@/components/season-board';

export const metadata: Metadata = {
  title: 'Season, Probatio',
  description:
    'The running season: the pot, who is winning, what each place pays, and the rules it is being run under.',
};

/**
 * The season, on its own page.
 *
 * The front page summarises it, which is right for somebody arriving — but a
 * summary is not somewhere to come back to. This is: the full board, every
 * trader's return and equity and trade count, and what each place would be paid
 * if it ended right now.
 */
export default function SeasonPage() {
  return (
    <main>
      <SeasonBoard />

      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/rules</span>
          <span>how a season is decided</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body prose">
          <p>
            Highest return wins. Everyone starts with the same balance, trades against the same
            live markets, and gets the same fill conditions: the same latency, the same slippage
            limit, the same maximum price impact. Those conditions are hashed into the season&apos;s
            ruleset and published before anybody enters, so they cannot be changed partway
            through without the change being visible.
          </p>
          <p>
            Open positions are marked at the current price. A trader holding a winner is ahead of
            one holding cash, which they are, even before they sell.
          </p>
          <p>
            If a season runs under broken conditions it does not count, and every entrant is
            refunded exactly what they paid with no house cut. The triggers are{' '}
            <a href="/docs">published in advance and measured</a> rather than judged after the
            fact, and once results are on chain a season can never be voided.
          </p>
        </div>
      </section>
    </main>
  );
}
