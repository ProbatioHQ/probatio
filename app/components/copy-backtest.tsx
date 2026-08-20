'use client';

import { useEffect, useState } from 'react';

/**
 * The gap between a wallet's return and yours, shown rather than hidden.
 *
 * A leader board tells somebody a wallet made 340%. The question they actually
 * have is whether copying it would have made them anything, and the honest
 * answer is almost always a much smaller number, because they would have
 * bought after the leader into a pool the leader had just moved.
 *
 * Opened per row rather than computed for the whole board, because it is a
 * replay through the fill engine and nobody needs fifty of them at once.
 */

interface Leg {
  mint: string;
  isBuy: boolean;
  at: number;
  sol: string;
  leaderPrice: string;
  copierPrice: string;
}

interface Result {
  available: boolean;
  reason?: string;
  windowDays: number;
  startingBalance?: string;
  endingEquity?: string;
  returnBps?: number;
  leaderReturnBps?: number;
  leaderRealized?: string;
  copierRealized?: string;
  latencyCost?: string;
  copied?: number;
  skipped?: number;
  legs?: Leg[];
}

const LAMPORTS = 1_000_000_000;

/*
 * `toFixed` hands back exponential notation above 1e21, so a figure that has
 * gone wrong upstream arrives on the page as `3.020922513084476e+24 SOL`
 * rather than as anything a reader can see is nonsense. The arithmetic that
 * produced that is fixed; this is so the next one announces itself instead of
 * dressing up as a price.
 */
function sol(lamports: string | undefined): string {
  if (!lamports) return '0.00';
  const value = Number(BigInt(lamports)) / LAMPORTS;
  if (!Number.isFinite(value) || Math.abs(value) >= 1e12) return 'out of range';
  return value.toFixed(2);
}

function percent(bps: number | undefined): string {
  if (bps === undefined) return '0.0%';
  const value = bps / 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/**
 * The button and the panel are separate on purpose.
 *
 * The row is a CSS grid, so anything rendered inside one of its cells is a
 * grandchild of the grid and cannot span it. The first version put the panel in
 * the last cell, where `grid-column: 1 / -1` silently did nothing and the panel
 * floated over the row it belonged to. The board is a flex column, so a panel
 * rendered as the row's sibling takes the full width without being told to.
 */
export function CopyButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="copy-btn" onClick={onClick} aria-expanded={open}>
      {open ? 'Hide' : 'If I copied'}
    </button>
  );
}

export function CopyBacktest({ trader }: { trader: string }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(true);

  // Mounted only when the row is opened, so the replay runs on the wallet
  // somebody actually asked about rather than on all fifty.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void fetch(`/api/copy-backtest?trader=${encodeURIComponent(trader)}`, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<Result>) : null))
      .then((body) => {
        if (cancelled) return;
        setResult(body ?? { available: false, windowDays: 30, reason: 'could not run' });
      })
      .catch(() => {
        if (!cancelled) setResult({ available: false, windowDays: 30, reason: 'could not run' });
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trader]);

  return (
    <div className="copy-panel">
        {busy && <p className="dim">Replaying their trades through the engine…</p>}

        {!busy && result && !result.available && (
          <p className="dim">
            Not enough of this wallet&apos;s history has been read yet to price a copy of it.
            {result.reason ? ` (${result.reason})` : ''}
          </p>
        )}

        {!busy && result?.available && (
          <>
            <div className="copy-figures">
              <span className="copy-fig">
                <b className={(result.leaderReturnBps ?? 0) >= 0 ? 'gain' : 'loss'}>
                  {percent(result.leaderReturnBps)}
                </b>
                <span>at their prices</span>
              </span>
              <span className="copy-arrow" aria-hidden="true">
                →
              </span>
              <span className="copy-fig">
                <b className={(result.returnBps ?? 0) >= 0 ? 'gain' : 'loss'}>
                  {percent(result.returnBps)}
                </b>
                <span>at yours</span>
              </span>
            </div>

            <p className="copy-say">
              The same {sol(result.startingBalance)} SOL, the same entries, the same fractional
              exits, over the last {result.windowDays} days: {result.copied} trades. The only
              difference between the two figures is the price each side gets. Filled at their
              prices it realizes {sol(result.leaderRealized)} SOL; filled at yours,{' '}
              {sol(result.copierRealized)} SOL.{' '}
              {/* The number the whole feature exists to produce. */}
              <b>{sol(result.latencyCost)} SOL</b> of that gap is what the worse price cost across
              every leg: arriving into the pool their own order had just moved, plus the impact
              your own size makes, both charged by the engine that quotes every fill here.
            </p>

            {result.legs && result.legs.length > 0 && (
              <ol className="copy-legs">
                {result.legs.map((leg, index) => {
                  const worse =
                    leg.isBuy
                      ? BigInt(leg.copierPrice) > BigInt(leg.leaderPrice)
                      : BigInt(leg.copierPrice) < BigInt(leg.leaderPrice);
                  return (
                    <li key={`${leg.at}-${index}`}>
                      <span className={leg.isBuy ? 'spectate-side buy' : 'spectate-side sell'}>
                        {leg.isBuy ? 'buy' : 'sell'}
                      </span>
                      <a href={`/t/${leg.mint}`} className="copy-mint">
                        {leg.mint.slice(0, 4)}…{leg.mint.slice(-4)}
                      </a>
                      <span className="copy-size">{sol(leg.sol)} SOL</span>
                      <span className={worse ? 'copy-worse' : 'dim'}>
                        {worse ? 'worse price than them' : 'same or better'}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
        </>
        )}
    </div>
  );
}
