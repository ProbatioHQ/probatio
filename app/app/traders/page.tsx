import type { Metadata } from 'next';
import { TradersBoard } from '@/components/traders-board';
import { RealTraders } from '@/components/real-traders';

export const metadata: Metadata = {
  title: 'Traders, Probatio',
  description:
    'Everybody trading on Probatio, ranked by return. Every record on this page can be verified by anyone.',
};

export const revalidate = 30;

/**
 * Who trades here.
 *
 * The season page answers "who is winning the season", which is a narrower
 * question than the one somebody asks when they look for a leaderboard, and it
 * showed one row while fifteen people were trading. This is the wider answer:
 * every account that has ever filled anything, ranked together, with the free
 * play ones marked as such.
 */
export default function TradersPage() {
  return (
    <main className="wide">
      <div className="page-head">
        <h1>Traders</h1>
        <p className="dim">
          Everybody who trades here, ranked by return. Free play and ranked seasons are marked
          separately, because they are not the same contest. Practice SOL bought in the store
          counts against the return rather than towards it, so nobody climbs this board by
          spending. Set a display name in your account and anyone can find you by it.
        </p>
      </div>

      <TradersBoard />

      {/*
        The other kind of trader.
        
        Everything above is people trading paper here. This is people trading
        their own money on pump.fun, ranked on what they actually made, read
        from swaps this site already pulls off the chain to draw its charts.
      */}
      <section>
        <h2>Real pump.fun traders</h2>
        <p className="dim">
          Not Probatio accounts. These are real wallets trading real money, ranked on what they
          made on positions they have finished with, read straight from the chain.
        </p>
        <RealTraders />
      </section>

      <p className="dim" style={{ fontSize: 13, marginTop: 40 }}>
        Every record here can be checked by anyone, in a browser or from a terminal, without
        trusting this page. <a href="/verify">Verify a record</a>, or{' '}
        <a href="/season">see the ranked season</a>.
      </p>
    </main>
  );
}
