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
  const { status } = useWallet();
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
        <span className="feed-portfolio-k">Practice money, real prices</span>
        <span className="feed-portfolio-say">
          Connect a wallet from the menu to trade any of these with 10 SOL of practice money.
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
