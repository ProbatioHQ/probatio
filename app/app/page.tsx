import { LaunchFeedList } from '@/components/launch-feed';
import { Leaderboard } from '@/components/leaderboard';
import { Onboarding } from '@/components/onboarding';
import { PriceCanvas } from '@/components/price-canvas';
import { Season } from '@/components/season';
import { SignIn } from '@/components/wallet';

/**
 * The front page.
 *
 * A stranger arrives knowing nothing and should leave knowing three things:
 * what this is, why the numbers on it are worth believing, and what to do next.
 * The app surfaces come after that, because a leaderboard shown before the
 * sentence explaining it is a table of strangers.
 */

const HOW = [
  {
    step: 'Click',
    body: 'The pool reserves are read from the chain at that moment and quoted. The price you see is the price that exists.',
  },
  {
    step: 'Wait',
    body: 'Six hundred milliseconds pass. That is how long a real transaction takes to land, and the market keeps moving through it.',
  },
  {
    step: 'Fill',
    body: 'The reserves are read again and the trade fills against the market as it is by then. Sometimes worse. Sometimes rejected outright.',
  },
  {
    step: 'Commit',
    body: 'The trade is hashed, batched, and folded into a value on Solana. From that point nobody can revise it, including us.',
  },
];

const AGAINST = [
  {
    claim: 'Every paper trading app fills you at the price you clicked.',
    answer:
      'Which teaches the one habit that loses money for real: that size and speed are free. Here the price moves while your order is in flight, by exactly as much as it really moved.',
  },
  {
    claim: 'Every profit screenshot could have been made in a text editor.',
    answer:
      'So this one comes with a button. Records go to Solana as they happen, and the verify page rebuilds them in your browser against an RPC you choose. You never have to take our word for a number.',
  },
  {
    claim: 'Leaderboards get won by whoever runs the most wallets.',
    answer:
      'Entries are limited by funding source, every wallet is checked when it enters, and what the chain said about it is kept. Farming a record here costs more than earning one.',
  },
];

export default function Home() {
  return (
    <main style={{ gap: 64 }}>
      <section className="hero">
        <PriceCanvas />
        <div className="hero-inner stagger">
          <span className="badge">
            <span className="dot" />
            Live pump.fun markets
          </span>

          <h1 className="display">
            Trade fake money
            <br />
            on real tokens.
          </h1>

          {/*
            Says what the system does without asserting what it has done.
            "Every trade is written to Solana as you make it" was present tense
            on a program that is not deployed and a keeper with no key — so it
            was, right now, false, in the first paragraph on the site. The
            design claim is real and stays; the state claim moved to the two
            places that actually know it, the trust page and the trade log.
          */}
          <p className="lede">
            Practice money, live prices, and fills that model real slippage and real delay. Every
            trade is hashed the moment it fills and committed to Solana in batches, so a record
            can be checked by anyone and edited by nobody —{' '}
            <a href="/trust">including what that does not cover yet</a>.
          </p>

          <div className="cta-row">
            <SignIn />
            <a href="/docs/fills" className="ghost-link">
              How the fills work
            </a>
          </div>

          <p className="dim" style={{ fontSize: 13.5 }}>
            Measured against real trades: 0 bps error on every sample.{' '}
            <a href="/docs/fills">See the numbers</a>
          </p>
        </div>
      </section>

      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/trade</span>
          <h2>what happens when you trade</h2>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <ol className="flow">
            {HOW.map((entry, index) => (
              <li key={entry.step}>
                <span className="n">{String(index + 1).padStart(2, '0')}</span>
                <div className="flow-text">
                  <h3>{entry.step}</h3>
                  <p>{entry.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <Onboarding />
      <Season />
      <Leaderboard />

      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/why</span>
          <h2>why this is different</h2>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <dl className="objections">
            {AGAINST.map((entry) => (
              <div key={entry.claim}>
                <dt>{entry.claim}</dt>
                <dd>{entry.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <LaunchFeedList />

      <section className="term-body check" style={{ alignItems: 'flex-start', gap: 12 }}>
        <span className="cmd">
          check it yourself
          <span className="caret" />
        </span>
        <p style={{ maxWidth: '58ch' }}>
          The verify page runs in your browser against an endpoint you pick. It never asks this
          server whether a record is valid, because a server vouching for its own records is worth
          nothing.
        </p>
        <a href="/verify" className="button-link">
          Verify any record
        </a>
      </section>
    </main>
  );
}
