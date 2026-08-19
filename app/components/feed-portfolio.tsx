'use client';

import { useEffect, useState } from 'react';
import { useWallet } from '@/components/wallet';

/**
 * What you are worth, above the feed, on a phone.
 *
 * The space over the lane buttons was empty, which is the worst thing a screen
 * can be: it reads as something that failed to load rather than as nothing to
 * show. Every app this competes with opens on a number, because the question
 * somebody has when they pick the app up is how they are doing, and they should
 * not have to go and find out.
 *
 * Equity, not cash. A trader holding a winner is ahead of one holding nothing,
 * and a balance that drops every time they buy something says the opposite.
 *
 * Signed out it says what this is instead of showing a zero. A zero would be a
 * lie about an account that does not exist yet.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

interface Snapshot {
  startingBalance: string;
  equity: {
    equity: string;
    totalPnl: string;
    returnBps: number;
  };
}

function sol(lamports: string): number {
  return Number(BigInt(lamports)) / LAMPORTS_PER_SOL;
}

/** Signed, so a loss reads as a loss rather than as a smaller number. */
function signed(value: number, places: number): string {
  const body = Math.abs(value).toFixed(places);
  return value < 0 ? `-${body}` : `+${body}`;
}

export function FeedPortfolio() {
  const { status, signIn } = useWallet();
  const signedIn = status === 'signed-in';
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    const read = (): void => {
      void fetch('/api/positions', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: Snapshot | { error: string } | null) => {
          if (cancelled || !body || 'error' in body) return;
          setSnapshot(body);
        })
        .catch(() => undefined);
    };
    read();
    // Positions move while somebody is reading the feed, so this is worth
    // keeping current, but not worth polling hard: it is a headline, not a fill.
    const timer = setInterval(read, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signedIn]);

  if (!signedIn) {
    return (
      <div className="feed-portfolio out">
        <span className="feed-portfolio-k">Paper money, real prices</span>
        {/*
          The action inside the sentence, not underneath it.
          
          This was a full-width button, which is a second call to action on a
          screen whose job is to list tokens, and louder than the row it sits
          in. The words that name the action carry it instead. Still a real
          button underneath, so it is reachable by keyboard and announced as
          something that does a thing, and it calls the same signIn as every
          other connect control, so a phone with no injected provider is handed
          to Phantom's browser exactly as it is everywhere else.
        */}
        {/*
          Three short sentences, where there were forty-four words.

          On a phone this sat above the tokens somebody came to look at, and at
          that length it was a wall to be scrolled past rather than read. What
          went is the explanation of how signing works, which belongs on the
          page about trust and not in front of a feed. What stayed is the two
          things that decide whether to tap: what the paper money is, and
          that nothing real can move.
        */}
        <span className="feed-portfolio-say">
          Every pump.fun launch, priced against the real curve.{' '}
          <button
            type="button"
            className="linklike feed-portfolio-connect"
            disabled={status === 'working'}
            onClick={() => void signIn()}
          >
            {status === 'working' ? 'Waiting for your wallet…' : 'Connect a wallet'}
          </button>{' '}
          to trade with 10 SOL of paper money. Nothing ever moves real funds.
        </span>
      </div>
    );
  }

  // The row holds its height while the first read is in flight, so the feed
  // under it does not jump down the moment the number arrives.
  if (!snapshot) {
    return (
      <div className="feed-portfolio">
        <span className="feed-portfolio-k">Your portfolio</span>
        <span className="feed-portfolio-value">…</span>
      </div>
    );
  }

  const equity = sol(snapshot.equity.equity);
  const pnl = sol(snapshot.equity.totalPnl);
  const percent = snapshot.equity.returnBps / 100;
  const up = pnl >= 0;

  return (
    <div className="feed-portfolio">
      <span className="feed-portfolio-k">Your portfolio</span>
      <span className="feed-portfolio-value">{equity.toFixed(3)} SOL</span>
      <span className="feed-portfolio-move">
        <span className={up ? 'gain' : 'loss'}>{signed(pnl, 3)} SOL</span>
        <span className={up ? 'feed-portfolio-pct gain' : 'feed-portfolio-pct loss'}>
          {signed(percent, 1)}%
        </span>
      </span>
    </div>
  );
}
