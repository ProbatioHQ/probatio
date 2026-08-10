'use client';

import { useEffect, useState } from 'react';

/**
 * The guide to a first trade.
 *
 * Someone who arrives, connects a wallet and lands on an empty screen leaves
 * and does not come back. This exists to carry them to their first fill, and
 * then to get out of the way — once a trade exists it disappears and never
 * returns, because a product that keeps explaining itself to people who
 * already understand it is worse than one that never explained anything.
 */

interface Progress {
  signedIn: boolean;
  pubkey?: string;
  tradeCount: number;
  done: boolean;
}

const STEPS = [
  {
    title: 'Connect a wallet',
    body: 'Signing proves the wallet is yours. It authorises no transaction and cannot move your funds.',
  },
  {
    title: 'Open a token',
    body: 'Pick anything from the feed. Prices, liquidity and fees are the real ones, read from the chain.',
  },
  {
    title: 'Make a trade',
    body:
      'You start with 10 SOL of practice money. The fill is quoted when you click and lands after a real delay, ' +
      'so the price moves while you wait — and sometimes the trade fails, exactly as it would with real money.',
  },
] as const;

export function Onboarding({ compact = false }: { compact?: boolean }) {
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/onboarding')
      .then((response) => response.json() as Promise<Progress>)
      .then((body) => {
        if (!cancelled) setProgress(body);
      })
      .catch(() => {
        // A guide that cannot load its own state should simply not appear
        // rather than show an error about itself.
        if (!cancelled) setProgress({ signedIn: false, tradeCount: 0, done: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing at all until the state is known — a guide that flashes the wrong
  // step and then corrects itself is worse than a moment of quiet.
  if (!progress || progress.done) return null;

  const current = !progress.signedIn ? 0 : compact ? 2 : 1;

  return (
    <aside aria-label="Getting started" className="panel">
      <h2>Getting started</h2>
      <ol className="steps">
        {STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li key={step.title} aria-current={state === 'current' ? 'step' : undefined}>
              <strong>{step.title}</strong>
              {state === 'done' && <span aria-label="done"> — done</span>}
              {state === 'current' && <p>{step.body}</p>}
            </li>
          );
        })}
      </ol>
      <p>
        Free, and nothing here risks real money. Your record is written to the chain as you
        trade, so it can be checked later by anyone — including against us.
      </p>
    </aside>
  );
}
