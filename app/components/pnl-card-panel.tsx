'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShareCard, type TradeCardData } from './share-card';

/**
 * A way into the PNL card for the token being looked at.
 *
 * One line, above the trade panel, in the chart's own column: the return and a
 * way in. It is deliberately the smallest thing on that side of the page. The
 * card is the payoff and this is only the door to it, so anything more here
 * would be a second panel competing with the one people came to trade in.
 *
 * ONLY THIS TOKEN
 *
 * A list of every closed trip on the account would be a portfolio, and a
 * portfolio does not belong beside one token's chart. Somebody on a token page
 * is thinking about that token; offering them a card for a different one is
 * noise at best and a misclick at worst.
 */

interface Props {
  /** Bumped by the page after a fill, so a new round trip appears on its own. */
  readonly refreshKey?: number;
  /** The token on screen. Nothing outside it is offered. */
  readonly mint: string;
}

export function PnlCardPanel({ refreshKey = 0, mint }: Props) {
  const [trades, setTrades] = useState<TradeCardData[]>([]);
  const [open, setOpen] = useState<TradeCardData | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/card', { cache: 'no-store' });
    // A 401 is a visitor who is not signed in, which is not an error worth
    // saying anything about here: the trade panel below already says it.
    if (!response.ok) return;
    const body = (await response.json()) as { trades: TradeCardData[] };
    setTrades((body.trades ?? []).filter((trade) => trade.mint === mint));
  }, [mint]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /*
   * Nothing at all until this token has a closed round trip.
   *
   * An empty row reading "no card yet" above the trade panel is furniture, and
   * furniture in the one column somebody is trying to trade in is worse than
   * absent.
   */
  const latest = trades[0];
  if (!latest) return null;

  return (
    <>
      <button type="button" className="pnl-strip" onClick={() => setOpen(latest)}>
        <span className="pnl-strip-label">PNL card</span>
        <span className={latest.returnBps >= 0 ? 'pnl-strip-ret gain' : 'pnl-strip-ret loss'}>
          {latest.returnBps >= 0 ? '+' : ''}
          {(latest.returnBps / 100).toFixed(1)}%
        </span>
        {/* Only when there is more than one, so the common case stays one line
            with nothing extra on it. */}
        {trades.length > 1 && <span className="pnl-strip-more">{trades.length}</span>}
      </button>

      {/*
        Over the page rather than inside a 320px column. The card is sixteen by
        nine and meant to be looked at before it is posted, which cannot be done
        in a strip beside a chart.
      */}
      {open && (
        <div
          className="pnl-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Your PNL card"
          onClick={(event) => {
            // Only the backdrop closes it. A click that began inside the card,
            // on a swatch or a button, must not fall through to here.
            if (event.target === event.currentTarget) setOpen(null);
          }}
        >
          <div className="pnl-overlay-inner">
            <ShareCard trade={open} onClose={() => setOpen(null)} />
          </div>
        </div>
      )}
    </>
  );
}
