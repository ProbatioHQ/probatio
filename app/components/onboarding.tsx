'use client';

import { useEffect, useState } from 'react';
import { useWallet } from './wallet';

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
      'so the price moves while you wait, and sometimes the trade fails, exactly as it would with real money.',
  },
] as const;

export function Onboarding({ compact = false }: { compact?: boolean }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  // The wallet signs in without a reload, so read progress again whenever that
  // state changes. Fetched once, the guide sat on "Connect a wallet" after the
  // user had already connected, telling them to do the thing they just did.
  const { status, pubkey } = useWallet();

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
  }, [status, pubkey]);

  // Nothing at all until the state is known: a guide that flashes the wrong
  // step and then corrects itself is worse than a moment of quiet.
  if (!progress || progress.done) return null;

  const current = !progress.signedIn ? 0 : compact ? 2 : 1;

  return (
    <aside aria-label="Getting started" className="term">
      <div className="term-bar">
        <span className="prompt">~/start</span>
        <span>getting started</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="term-body">
        {/*
          Every step shows its text now. The old version revealed only the
          current one, which left two headings with nothing under them and a
          closing paragraph on a different left edge, so the panel read as
          broken rather than as a sequence in progress.
        */}
        <ol className="steps">
          {STEPS.map((step, index) => {
            const state = index < current ? 'done' : index === current ? 'current' : 'todo';
            return (
              <li
                key={step.title}
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="tick" aria-hidden="true">
                  {state === 'done' ? '[x]' : state === 'current' ? '[>]' : '[ ]'}
                </span>
                <div className="step-text">
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <p className="footnote">
          Free, and nothing here risks real money. Every trade is hashed as it fills and
          committed to the chain in batches, so a record can be checked later by anyone,
          including against us. <a href="/trust">Here is what that does not cover yet</a>.
        </p>
      </div>
    </aside>
  );
}
