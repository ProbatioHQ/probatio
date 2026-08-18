'use client';

import { useEffect, useState } from 'react';
import { EnterSeason } from './enter-season';
import { useWallet } from './wallet';
import { countdown } from '@/lib/season-format';

/**
 * The season, in full.
 *
 * The front page carries a summary because a stranger needs the headline. This
 * is the other thing: who is actually winning, by how much, on how many trades,
 * and what each of them would be paid if it ended now. A standings table with
 * only a percentage in it does not answer the question people come back for.
 */

interface Payout {
  place: number;
  lamports: string;
}

interface Ranked {
  ordinal: number;
  name: string;
  status: 'pending' | 'entry_open' | 'running' | 'closed' | 'finalized';
  startsAt: number;
  endsAt: number;
  entryClosesAt: number;
  entryClosesInMs: number | null;
  entryCost: string;
  startingBalance: string;
  entrants: number;
  potLamports: string;
  entriesLamports: string;
  sponsorLamports: string;
  payouts: Payout[];
  paidPlaces: number;
  nextBand: { places: number; entriesAway: number } | null;
  rulesetHash: string;
  entered: boolean;
  /** False when this server cannot take an entry. See /api/season. */
  entryAvailable?: boolean;
  /** Why, in the server's words. Null when entry is available. */
  entryUnavailableReason?: string | null;
}

interface Row {
  rank: number;
  trader: string;
  name: string | null;
  returnBps: number;
  finalEquity: string;
  startingBalance: string;
  tradeCount: number;
  payoutLamports: string;
}

interface Board {
  season: { ordinal: number; status: string } | null;
  standings: Row[];
  you: Row | null;
  total: number;
  final: boolean;
  markedAt: number;
}

const LAMPORTS = 1_000_000_000n;

function sol(lamports: string, places = 2): string {
  const value = BigInt(lamports);
  const scale = 10n ** BigInt(places);
  const whole = value / LAMPORTS;
  const fraction = ((value % LAMPORTS) * scale) / LAMPORTS;
  return `${whole}.${fraction.toString().padStart(places, '0')}`;
}

function percent(bps: number): string {
  return `${bps > 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`;
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

function place(rank: number): string {
  return ORDINALS[rank - 1] ?? `${rank}th`;
}

export function SeasonBoard() {
  const { pubkey } = useWallet();
  const [season, setSeason] = useState<Ranked | null | 'none'>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;

    const read = (): void => {
      void fetch('/api/season')
        .then((response) => response.json() as Promise<{ ranked: Ranked | null }>)
        .then((body) => {
          if (!cancelled) setSeason(body.ranked ?? 'none');
        })
        .catch(() => undefined);

      void fetch('/api/leaderboard?limit=200')
        .then((response) => response.json() as Promise<Board>)
        .then((body) => {
          if (!cancelled) setBoard(body);
        })
        .catch(() => undefined);
    };

    read();
    // The standings are marked to the market, so they move even when nobody
    // trades. A board that only changes on reload is a screenshot.
    const timer = setInterval(read, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Separate from the fetch: the countdown has to tick every second, and
  // re-reading the season every second to do it would be absurd.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (season === null) {
    return <p className="dim">Loading the season…</p>;
  }

  if (season === 'none') {
    return (
      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/season</span>
          <span>none scheduled</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <p className="dim">
            No ranked season is running. Free play is always open, and trades made in it are
            recorded the same way. They just are not ranked for a prize.
          </p>
        </div>
      </section>
    );
  }

  const closed = season.status === 'closed' || season.status === 'finalized';
  const entryOpen = season.status === 'entry_open';
  const entryClosesIn = season.entryClosesAt - now;
  const endsIn = season.endsAt - now;
  const topPayout = season.payouts.reduce(
    (max, payout) => (BigInt(payout.lamports) > max ? BigInt(payout.lamports) : max),
    1n,
  );

  return (
    <>
      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/season</span>
          <span>{season.name.toLowerCase()}</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>

        <div className="term-body">
          <div className="season-head">
            <h1 style={{ fontSize: 28 }}>{season.name}</h1>
            {/* Finalized is not the same as closed, and the difference is the
                one that matters to somebody owed money: closed means trading
                stopped, finalized means the results are settled and a prize
                can be claimed against them. Both used to read "closed". */}
            <span className={`pill ${closed ? 'closed' : 'live'}`}>
              {season.status === 'finalized'
                ? 'final'
                : season.status === 'closed'
                  ? 'closed'
                  : entryOpen
                    ? 'entry open'
                    : season.status.replace('_', ' ')}
            </span>
          </div>

          <div className="stat-row">
            <div className="stat">
              <span className="k">Prize pool</span>
              <span className="v hot">{sol(season.potLamports)} SOL</span>
            </div>
            <div className="stat">
              <span className="k">Entrants</span>
              <span className="v">{season.entrants}</span>
            </div>
            <div className="stat">
              <span className="k">Entry</span>
              <span className="v">
                {BigInt(season.entryCost) === 0n ? 'free' : `${sol(season.entryCost, 3)} SOL`}
              </span>
            </div>
            {/* Three questions, not one with a broken answer. A finished season
                read "Season ends in: closed", which is a label its own value
                does not answer: the countdown returns "closed" at zero and the
                label never changed with it. */}
            <div className="stat">
              <span className="k">
                {closed ? 'Ended' : entryClosesIn > 0 ? 'Entry closes in' : 'Season ends in'}
              </span>
              <span className="v">
                {closed
                  ? new Date(season.endsAt).toLocaleDateString(undefined, {
                      day: 'numeric',
                      month: 'short',
                    })
                  : countdown(entryClosesIn > 0 ? entryClosesIn : endsIn)}
              </span>
            </div>
          </div>

          {/* Where the pot came from. It matters if the season voids: entries
              are owed back, a sponsored prize never belonged to the entrants. */}
          {BigInt(season.sponsorLamports) > 0n && (
            <p className="dim" style={{ fontSize: 13 }}>
              {sol(season.sponsorLamports)} SOL of the pool is put up rather than paid for by
              entries.
            </p>
          )}

          {season.payouts.length > 0 && (
            <div className="payouts">
              <span className="cmd">
                payouts if it ended now
                <span className="caret" />
              </span>
              <ul className="bare">
                {season.payouts.map((payout) => (
                  <li key={payout.place}>
                    <span className="place">{place(payout.place)}</span>
                    <span
                      className="bar"
                      style={{
                        width: `${Math.max(6, Number((BigInt(payout.lamports) * 100n) / topPayout))}%`,
                      }}
                    />
                    <span className="amount">{sol(payout.lamports)} SOL</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {season.nextBand && !closed && (
            <p className="nudge">
              <span className="accent">{season.nextBand.entriesAway} more</span>{' '}
              {season.nextBand.entriesAway === 1 ? 'entry' : 'entries'} and the top{' '}
              {season.nextBand.places} all get paid.
            </p>
          )}

          <hr />

          {/* Offered only when the server can actually take it. A paid
                season needs a treasury address, which is configuration
                rather than code. Without it the button drew, the reader
                pressed it, and only then met a refusal. */}
          {season.entered ? (
            <p className="accent mono">You are entered. Every ranked trade counts.</p>
          ) : entryOpen && season.entryAvailable !== false ? (
            <EnterSeason free={BigInt(season.entryCost) === 0n} />
          ) : entryOpen ? (
            /* The server's own reason, not one guessed here. There is more than
               one way for entry to be unavailable and this used to name only
               the missing address, which was the wrong answer to give somebody
               the moment a second reason existed. */
            <p className="dim">
              {season.entryUnavailableReason ??
                'Entry is not open on this server yet. Free play is open, and trades made in it are committed the same way.'}
            </p>
          ) : closed ? (
            <p className="dim">This season is over.</p>
          ) : (
            <p className="dim">
              Entries are closed for this season. Free play is always open, and the next season
              starts when this one ends.
            </p>
          )}

          <p>
            <small className="mono">ruleset {season.rulesetHash.slice(0, 24)}…</small>
          </p>
        </div>
      </section>

      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/standings</span>
          <span>season {season.ordinal}</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>

        <div className="term-body">
          <div className="season-head">
            <h2>Standings</h2>
            <span className={`pill ${board?.final ? '' : 'live'}`}>
              {board?.final ? 'final' : 'live'}
            </span>
          </div>

          {!board ? (
            <p className="dim">Loading…</p>
          ) : board.standings.length === 0 ? (
            <p className="dim">Nobody has entered yet. First in is first on the board.</p>
          ) : (
            <>
              <div className="scroller standings-wrap">
                <table className="standings">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Trader</th>
                      <th scope="col">Return</th>
                      <th scope="col">Equity</th>
                      <th scope="col">Trades</th>
                      <th scope="col">Pays</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.standings.map((row) => (
                      <StandingRow key={row.trader} row={row} you={row.trader === pubkey} />
                    ))}
                    {board.you && <StandingRow row={board.you} you />}
                  </tbody>
                </table>
              </div>

              <p className="dim" style={{ fontSize: 13 }}>
                {board.final
                  ? 'Final. These are the numbers the results root was computed from.'
                  : 'Open positions are marked at the current price, so these move with the market rather than with a recount.'}
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}

function StandingRow({ row, you = false }: { row: Row; you?: boolean }) {
  const pnl = BigInt(row.finalEquity) - BigInt(row.startingBalance);
  const paying = row.payoutLamports !== '0';

  return (
    <tr aria-current={you ? 'true' : undefined} className={paying ? 'paying' : undefined}>
      <td className="rank">
        <span className={row.rank <= 3 ? `medal m${row.rank}` : 'medal'}>{row.rank}</span>
      </td>
      <td>
        {/* Every trader is a link. The whole argument is that a record can be
            checked, and a name you cannot click is not a record. */}
        <a className="mono trader" href={`/p/${row.trader}`}>
          {row.name ?? short(row.trader)}
          {you && <span className="you">you</span>}
        </a>
      </td>
      <td className={row.returnBps > 0 ? 'gain' : row.returnBps < 0 ? 'loss' : 'dim'}>
        {percent(row.returnBps)}
      </td>
      <td className="mono">
        {sol(row.finalEquity)}
        <span className={pnl > 0n ? 'gain delta' : pnl < 0n ? 'loss delta' : 'dim delta'}>
          {pnl >= 0n ? '+' : '−'}
          {sol((pnl < 0n ? -pnl : pnl).toString())}
        </span>
      </td>
      <td className="mono">{row.tradeCount}</td>
      <td className="mono">{paying ? `${sol(row.payoutLamports)} SOL` : ''}</td>
    </tr>
  );
}
