'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { CopyBacktest, CopyButton } from '@/components/copy-backtest';

/**
 * Real pump.fun wallets, ranked on money they actually made.
 *
 * Everything else on this site ranks people trading paper. This ranks people
 * trading their own money, from swaps read off the chain, and it is the board
 * that makes copying somebody worth building later.
 *
 * States its own coverage rather than implying it has all of pump.fun. It has
 * whatever pools have been walked here, which is the tokens people opened, and
 * a board that hid that would be claiming something it cannot support.
 */

interface Trader {
  trader: string;
  closedTrips: number;
  wins: number;
  realizedPnl: string;
  solTraded: string;
  tokens: number;
  lastTradedAt: number | null;
}

interface Payload {
  windowDays: number;
  minTrips: number;
  minStaked: string;
  coverage: { swaps: number; traders: number; tokens: number; scoreable: number };
  traders: Trader[];
}

const LAMPORTS = 1_000_000_000;

function sol(lamports: string): string {
  const value = Number(BigInt(lamports)) / LAMPORTS;
  const body = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return value > 0 ? `+${body}` : body;
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

/** Rows per page. A screenful, so the board is scrolled rather than endless. */
const PER_PAGE = 25;

/*
 * How often the board refetches itself.
 *
 * Wallet histories are being read in the background the whole time this page is
 * open, so a board loaded once is out of date within a minute of arriving. It
 * refreshes in place instead: no spinner, no flash, and an open panel stays
 * open, because the alternative is a page that quietly lies about how much has
 * been read.
 */
const REFRESH_MS = 30_000;

export function RealTraders() {
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);
  /*
   * Which row is expanded, held here rather than in the row.
   *
   * The panel has to render as the row's sibling to span the board, so the
   * open state belongs to whatever renders both of them.
   */
  const [open, setOpen] = useState<string | null>(null);
  /*
   * Where everybody stood last time this refreshed.
   *
   * A leaderboard that silently swaps its rows every thirty seconds reads as a
   * static image somebody occasionally replaces. Keeping the previous
   * positions lets a row say it moved, which is the difference between a table
   * and a contest.
   */
  const places = useRef<Map<string, number>>(new Map());
  const [moved, setMoved] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      void fetch('/api/real-traders', { cache: 'no-store' })
        .then((response) => (response.ok ? (response.json() as Promise<Payload>) : null))
        .then((body) => {
          if (cancelled) return;
          // A failed refresh leaves the board it already has rather than
          // replacing a working page with an error.
          if (body) {
            const shifts = new Map<string, number>();
            body.traders.forEach((row, index) => {
              const before = places.current.get(row.trader);
              if (before !== undefined && before !== index) shifts.set(row.trader, before - index);
            });
            places.current = new Map(body.traders.map((row, index) => [row.trader, index]));
            if (shifts.size > 0) setMoved(shifts);
            setData(body);
            setFailed(false);
          } else if (!data) setFailed(true);
        })
        .catch(() => {
          if (!cancelled && !data) setFailed(true);
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    // Movement is shown briefly and then stops being news.
    const clear = setInterval(() => setMoved(new Map()), REFRESH_MS - 4_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return <p className="dim">Could not load real traders.</p>;
  if (!data) return <p className="dim">Loading…</p>;

  /*
   * Two different empty states, because they mean different things.
   *
   * Nothing read at all is a harvester that has not got going yet. Wallets read
   * but none ranked is a floor doing its job. The first version said the same
   * sentence for both and there was no way to tell from the page which one was
   * happening.
   */
  if (data.traders.length === 0) {
    return (
      <p className="dim">
        {data.coverage.swaps === 0 ? (
          <>
            Nothing read yet. Real pump.fun swaps are being walked off the chain now; this fills in
            within a few minutes.
          </>
        ) : (
          <>
            {data.coverage.traders.toLocaleString()} wallets found in{' '}
            {data.coverage.swaps.toLocaleString()} real swaps, {data.coverage.scoreable} of them
            having sold something so far, none yet past the floor of {data.minTrips} sells. Their
            own trading histories are being read now, several at a time, and this page refreshes
            itself as they land.
          </>
        )}
      </p>
    );
  }

  const pages = Math.max(1, Math.ceil(data.traders.length / PER_PAGE));
  const current = Math.min(page, pages - 1);
  const rows = data.traders.slice(current * PER_PAGE, current * PER_PAGE + PER_PAGE);

  return (
    // One element rather than a fragment: see the note on the all-time board.
    <div className="board-shell">
      {/* Says the page is watching rather than showing. */}
      <div className="board-live">
        <span className="spectate-live on">
          <i aria-hidden="true" />
          Live
        </span>
        <span className="dim">
          {data.traders.length} wallets, rescored every {REFRESH_MS / 1000} seconds from{' '}
          {data.coverage.swaps.toLocaleString()} swaps read off the chain
        </span>
      </div>

      <div className="board" role="table">
        <div className="board-head" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">Wallet</span>
          <span role="columnheader">Made</span>
          <span role="columnheader">Traded</span>
          <span role="columnheader">Exits</span>
          <span role="columnheader">Hit rate</span>
          <span role="columnheader" />
        </div>

        {rows.map((trader, offset) => {
          const index = current * PER_PAGE + offset;
          const pnl = BigInt(trader.realizedPnl);
          const tone = pnl > 0n ? 'gain' : pnl < 0n ? 'loss' : 'dim';
          const hit = trader.closedTrips === 0 ? 0 : (trader.wins / trader.closedTrips) * 100;
          return (
            <Fragment key={trader.trader}>
            <div
              className={moved.has(trader.trader) ? 'board-row shifted' : 'board-row'}
              role="row"
            >
              <span className="board-rank" role="cell">
                <span className={index < 3 ? `medal m${index + 1}` : 'medal'}>{index + 1}</span>
                {/* Which way, and by how many. Drawn rather than written, so a
                    row that has not moved carries no furniture at all. */}
                {moved.has(trader.trader) && (
                  <span
                    className={(moved.get(trader.trader) ?? 0) > 0 ? 'board-move up' : 'board-move down'}
                    title={`${Math.abs(moved.get(trader.trader) ?? 0)} places`}
                  >
                    {Math.abs(moved.get(trader.trader) ?? 0)}
                  </span>
                )}
              </span>

              {/* Out to a chain explorer, not to a profile here. This wallet
                  has no Probatio record and pretending otherwise would be the
                  one dishonest thing this board could do. */}
              <a
                className="board-trader"
                role="cell"
                href={`https://solscan.io/account/${trader.trader}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span className="board-name mono">{short(trader.trader)}</span>
              </a>

              <span className={`board-return ${tone}`} role="cell">
                {sol(trader.realizedPnl)}
              </span>

              <span className="board-equity" role="cell">
                <span className="board-figure">{sol(trader.solTraded).replace('+', '')}</span>
              </span>

              <span className="board-trades" role="cell">
                {trader.closedTrips}
              </span>

              <span className="board-pays" role="cell">
                <span className="dim">{hit.toFixed(0)}%</span>
              </span>

              {/* The question a board like this always provokes, answered in
                  place rather than left for somebody to guess at. */}
              <span className="board-copy" role="cell">
                <CopyButton
                  open={open === trader.trader}
                  onClick={() => setOpen(open === trader.trader ? null : trader.trader)}
                />
              </span>
            </div>
            {open === trader.trader && <CopyBacktest trader={trader.trader} />}
            </Fragment>
          );
        })}
      </div>

      {pages > 1 && (
        <nav className="board-pages" aria-label="More traders">
          <button
            type="button"
            className="copy-btn"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
          >
            Back
          </button>
          <span className="dim mono">
            {current * PER_PAGE + 1}&ndash;{current * PER_PAGE + rows.length} of{' '}
            {data.traders.length}
          </span>
          <button
            type="button"
            className="copy-btn"
            onClick={() => setPage(current + 1)}
            disabled={current >= pages - 1}
          >
            More
          </button>
        </nav>
      )}

      <p className="dim" style={{ fontSize: 13, marginTop: 4 }}>
        Scored in SOL, after fees, on the part of their positions these wallets have actually sold
        in the last {data.windowDays} days. Every sell is charged the average of what that wallet
        paid for what it held, and the difference is booked then; whatever is still held is never
        priced and never counted. A wallet needs {data.minTrips} sells to appear. Read from {data.coverage.swaps.toLocaleString()} real swaps across{' '}
        {data.coverage.tokens.toLocaleString()} tokens: the pools walked here, plus the full
        trading history of the wallets those pools turned up. Not all of pump.fun, and it does not
        pretend to be.
      </p>
    </div>
  );
}
