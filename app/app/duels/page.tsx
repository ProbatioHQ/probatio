import { DuelsView } from '@/components/duels-view';

export const metadata = {
  title: 'Duels, Probatio',
  description:
    'One trader against one, over a window you both agreed to, scored off the accounts you already entered the season with. Both records sealed.',
};

/**
 * Head to head duels.
 *
 * The last thing in phase one, and deliberately the smallest possible version of
 * it: an agreement and two equity snapshots. There is no duel balance, no duel
 * engine and no second entry, because every feature here that could have added a
 * second account has refused to for the same reason. One entry, one balance, one
 * row on the board.
 *
 * What a duel adds is not a different way to trade. It is a different way to
 * read the trading somebody was already doing, against exactly one other person,
 * over a window neither of them chose alone.
 */

export default function DuelsPage() {
  return (
    <main className="duels-page">
      <div className="page-head">
        <h1>Duels</h1>
        <p className="dim">
          One trader against one, over a window you both agreed to. It is scored off the account you
          already entered the season with, so there is nothing new to fund and nothing new to learn:
          trade exactly as you would have, and at the end the two returns are compared and both are
          sealed.
        </p>
      </div>

      <DuelsView />

      <section className="panel">
        <div className="panel-head">
          <h2>How it is scored</h2>
        </div>
        <dl className="plainlist">
          <dt>Your whole account, at both ends.</dt>
          <dd>
            SOL in hand plus every open position marked at what it is worth, read by the same code
            the leaderboard uses. A duel that invented its own idea of what an account is worth would
            eventually disagree with the board about who is ahead, and then neither number is worth
            anything.
          </dd>

          <dt>The clock starts on accept.</dt>
          <dd>
            Not when the offer was sent. Both accounts are measured at the moment the second person
            says yes, so nobody gets a head start by sitting on an offer while a position runs.
          </dd>

          <dt>A position nobody can price is counted at cost.</dt>
          <dd>
            The same fallback the all-time board uses. It is not a price, so a duel that leaned on
            one says so on the result rather than presenting a figure that is part measurement and
            part assumption without saying which.
          </dd>

          <dt>One duel at a time.</dt>
          <dd>
            Two live duels scored off one account would both be measuring the same trades, so a
            single good fill would win both. That is enforced by the database, not by this sentence.
          </dd>

          <dt>Nothing about it changes a fill.</dt>
          <dd>
            The same latency, the same slippage, the same price impact ceiling. A duel trade is an
            ordinary season trade that counts toward the leaderboard exactly as it would have, and
            it can be verified the same way.
          </dd>
        </dl>
      </section>

    </main>
  );
}
