'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Everybody who trades here.
 *
 * Reuses the `.board` grid the season standings use, so the two read as the
 * same object rather than two different tables that happen to be near each
 * other.
 */

interface Standing {
  trader: string;
  name: string | null;
  seasonName: string;
  ranked: boolean;
  startingBalance: string;
  equity: string;
  returnBps: number;
  tradeCount: number;
}

const LAMPORTS = 1_000_000_000;

function sol(lamports: string): string {
  return (Number(BigInt(lamports)) / LAMPORTS).toFixed(2);
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

function percent(bps: number): string {
  const value = bps / 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/** How often the board rescores itself. Matches the real-trader board. */
const REFRESH_MS = 30_000;

export function TradersBoard() {
  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  /* Previous positions, so a row can say it moved. See the real-trader board. */
  const places = useRef<Map<string, number>>(new Map());
  const [moved, setMoved] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    /*
     * Reloaded on a timer, because people trade while somebody is looking at
     * this. It used to load once, so a board opened in the morning was still
     * showing the morning at midnight, which is the same as being wrong.
     */
    const load = (): void => {
      void fetch('/api/traders', { cache: 'no-store' })
        .then((response) =>
          response.ok ? (response.json() as Promise<{ standings: Standing[] }>) : null,
        )
        .then((body) => {
          if (cancelled) return;
          if (body) {
            const shifts = new Map<string, number>();
            body.standings.forEach((row, index) => {
              const key = `${row.trader}-${row.seasonName}`;
              const before = places.current.get(key);
              if (before !== undefined && before !== index) shifts.set(key, before - index);
            });
            places.current = new Map(
              body.standings.map((row, index) => [`${row.trader}-${row.seasonName}`, index]),
            );
            if (shifts.size > 0) setMoved(shifts);
            setStandings(body.standings);
            setFailed(false);
          } else if (!standings) setFailed(true);
        })
        .catch(() => {
          if (!cancelled && !standings) setFailed(true);
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    const clear = setInterval(() => setMoved(new Map()), REFRESH_MS - 4_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) return <p className="dim">Could not load the traders.</p>;
  if (!standings) return <p className="dim">Loading…</p>;
  if (standings.length === 0) {
    return <p className="dim">Nobody has traded here yet. You could be first.</p>;
  }

  /*
   * Searched here rather than at the server.
   *
   * This endpoint returns the whole board, not a top slice, so filtering the
   * rows in hand finds everybody. A search that asked the server would have to
   * be built on a query with its own idea of who counts, and the one person a
   * search has to find is exactly the person too far down to be on a first
   * page.
   */
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? standings
        .map((standing, index) => ({ standing, index }))
        .filter(
          ({ standing }) =>
            (standing.name?.toLowerCase().includes(needle) ?? false) ||
            standing.trader.toLowerCase().includes(needle),
        )
    : standings.map((standing, index) => ({ standing, index }));

  return (
    /*
     * One element, not a fragment.
     *
     * `main` is a flex column with a 48px gap, so a fragment spills its
     * children straight into that gap and every piece of this board sat 48px
     * from the next one: the heading, the live line, the search and the table
     * were four separate islands. The shell keeps them together and sets its
     * own, much tighter, internal rhythm.
     */
    <div className="board-shell">
    <div className="board-live">
      <span className="spectate-live on">
        <i aria-hidden="true" />
        Live
      </span>
      <span className="dim">
        {standings.length} {standings.length === 1 ? 'trader' : 'traders'}, rescored every{' '}
        {REFRESH_MS / 1000} seconds
      </span>
    </div>

    <label className="field board-search">
      <span>Find a trader</span>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Display name, or paste a wallet address"
      />
    </label>

    {needle !== '' && (
      <p className="dim board-found">
        {matches.length === 0
          ? 'Nobody here by that name. Names are set in your account, and only show once that trader has filled something.'
          : `${matches.length} of ${standings.length} traders`}
      </p>
    )}

    <div className="board" role="table">
      <div className="board-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Trader</span>
        <span role="columnheader">Return</span>
        <span role="columnheader">Equity</span>
        <span role="columnheader">Trades</span>
        <span role="columnheader">Playing</span>
      </div>

      {/*
        Ranks come from the full board, not from the filtered list.
        
        Searching yourself should tell you where you actually stand. Numbering
        the matches from one would show every trader as first the moment they
        looked themselves up, which is the one lie a leaderboard cannot tell.
      */}
      {matches.map(({ standing, index }) => {
        const tone = standing.returnBps > 0 ? 'gain' : standing.returnBps < 0 ? 'loss' : 'dim';
        return (
          <div
            className={
              moved.has(`${standing.trader}-${standing.seasonName}`) ? 'board-row shifted' : 'board-row'
            }
            role="row"
            key={`${standing.trader}-${standing.seasonName}`}
          >
            <span className="board-rank" role="cell">
              <span className={index < 3 ? `medal m${index + 1}` : 'medal'}>{index + 1}</span>
              {moved.has(`${standing.trader}-${standing.seasonName}`) && (
                <span
                  className={
                    (moved.get(`${standing.trader}-${standing.seasonName}`) ?? 0) > 0
                      ? 'board-move up'
                      : 'board-move down'
                  }
                >
                  {Math.abs(moved.get(`${standing.trader}-${standing.seasonName}`) ?? 0)}
                </span>
              )}
            </span>

            {/* Every trader is a link, for the same reason the season board
                does it: a name you cannot click is not a record. */}
            <a className="board-trader" role="cell" href={`/p/${standing.trader}`}>
              <span className="board-name">{standing.name ?? short(standing.trader)}</span>
            </a>

            <span className={`board-return ${tone}`} role="cell">
              {percent(standing.returnBps)}
            </span>

            <span className="board-equity" role="cell">
              <span className="board-figure">{sol(standing.equity)}</span>
            </span>

            <span className="board-trades" role="cell">
              {standing.tradeCount}
            </span>

            {/* Free play and a ranked season are not the same contest, so the
                row says which it was rather than implying one league. */}
            <span className="board-pays" role="cell">
              {standing.ranked ? (
                <span className="pays-chip">{standing.seasonName}</span>
              ) : (
                <span className="dim">Free play</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
    </div>
  );
}
