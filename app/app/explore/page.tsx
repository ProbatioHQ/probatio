import type { Metadata } from 'next';
import { ExploreBoard } from '@/components/explore-board';
import { FeedPortfolio } from '@/components/feed-portfolio';

export const metadata: Metadata = {
  title: 'Explore, Probatio',
  description:
    'What is moving on pump.fun right now, ranked on the hour. Pick anything and trade it with paper money against the real prices.',
};

export const revalidate = 30;

/**
 * The other half of the terminal.
 *
 * The terminal is every launch as it happens, which is right for hunting and
 * wrong for arriving: a wall of thirty-second-old tokens tells a newcomer
 * nothing about what is worth looking at. This page answers that instead.
 *
 * Called Explore on a wide screen and Movers on a phone, because those are the
 * words each audience already uses, and it is one page either way.
 */
export default function ExplorePage() {
  return (
    <main className="wide explore-page">
      <div className="page-head">
        <h1>
          <span className="wide-name">Explore</span>
          <span className="narrow-name">Movers</span>
        </h1>
        <p className="dim">
          The biggest moves of the last hour, up or down, among tokens with real trading behind
          them. Pick anything and trade it with paper money against the real prices.
        </p>
      </div>

      {/*
        The same balance row the terminal carries.

        This page is the other way into trading, and it was the only one that
        did not say what you have to trade with. Somebody arriving here saw a
        board of tokens and no indication they had an account, or that they
        could open one. It is the same component, so the two pages cannot drift
        apart in what they claim.
      */}
      <FeedPortfolio />

      <ExploreBoard />

      {/*
        Whose opinion this is.
        
        Every other number on this site is derived here and checkable here. This
        ordering is not: it comes from pump.fun's listing and DEX Screener's
        hourly change, because there is price history here only for tokens
        somebody has already opened. Saying so is the same standard the rest of
        the site is held to.
      */}
      <p className="dim" style={{ fontSize: 13 }}>
        Ranked from pump.fun&apos;s own listings and DEX Screener&apos;s hourly change, not from
        this site&apos;s records, and filtered to tokens that moved at least a percent on at least
        $500 of trading in the last day. Fills are still quoted against the pool reserves this site reads directly.{' '}
        <a href="/trust">What you have to trust</a>.
      </p>
    </main>
  );
}
