'use client';

import { useEffect, useState } from 'react';
import { EnterSeason } from './enter-season';

/**
 * The season, and why bringing somebody matters.
 *
 * The number that does the work here is how many entries away the next payout
 * band is. A pot on its own is a fact; "four more and third place starts
 * paying" is a reason to tell someone.
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
  entryClosesInMs: number | null;
  entryCost: string;
  entrants: number;
  potLamports: string;
  payouts: Payout[];
  paidPlaces: number;
  nextBand: { places: number; entriesAway: number } | null;
  rulesetHash: string;
  entered: boolean;
  /** False when this server cannot take an entry — see /api/season. */
  entryAvailable?: boolean;
}

function sol(lamports: string): string {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = ((value % 1_000_000_000n) * 100n) / 1_000_000_000n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

function remaining(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

export function Season() {
  const [season, setSeason] = useState<Ranked | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/season')
      .then((response) => response.json() as Promise<{ ranked: Ranked | null }>)
      .then((body) => {
        if (!cancelled) setSeason(body.ranked);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // No ranked season is a normal state, not an error. Free play is the product.
  if (!season) return null;

  const closed = season.status === 'closed' || season.status === 'finalized';

  return (
    <section aria-label="Season" className="term">
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
          <h2>{season.name}</h2>
          <span className={`pill ${closed ? 'closed' : 'live'}`}>
            {season.status === 'finalized'
              ? 'final'
              : season.status === 'closed'
                ? 'closed'
                : season.status === 'pending'
                  ? 'opens soon'
                  : 'open'}
          </span>
        </div>

        {season.status === 'pending' && (
          <p className="dim">Opens {new Date(season.startsAt).toLocaleString()}.</p>
        )}
        {season.status === 'finalized' ? (
          <p className="dim">This season is over and its results are on chain.</p>
        ) : (
          closed && <p className="dim">This season is over. Results are not published yet.</p>
        )}

        {/* The three numbers somebody actually came for, at a size that says so. */}
        <div className="stat-row">
          <div className="stat">
            <span className="k">Prize pool</span>
            <span className="v hot">{sol(season.potLamports)} SOL</span>
          </div>
          <div className="stat">
            <span className="k">Entrants</span>
            <span className="v">{season.entrants}</span>
          </div>
          {season.entryClosesInMs !== null && (
            <div className="stat">
              <span className="k">Entry closes in</span>
              <span className="v">{remaining(season.entryClosesInMs)}</span>
            </div>
          )}
        </div>

        {season.payouts.length > 0 && (
          <div className="payouts">
            <span className="cmd">
              payouts
              <span className="caret" />
            </span>
            <ul className="bare">
              {season.payouts.map((payout) => (
                <li key={payout.place}>
                  <span className="place">{ORDINALS[payout.place - 1] ?? `${payout.place}th`}</span>
                  <span className="bar" style={{ width: `${share(payout.lamports, season)}%` }} />
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

        <p className="dim" style={{ fontSize: 13.5 }}>
          Highest return wins. Everyone starts with the same balance and the same fill
          conditions.
        </p>

        <hr />

        {/* Offered only when the server can actually take it. A paid
                season needs a treasury address, which is configuration
                rather than code — without it the button drew, the reader
                pressed it, and only then met a refusal. */}
        {season.entered ? (
          <p className="accent mono">You are entered.</p>
        ) : season.status === 'entry_open' && season.entryAvailable !== false ? (
          <EnterSeason free={BigInt(season.entryCost) === 0n} />
        ) : season.status === 'entry_open' ? (
          <p className="dim">
            Entry is not open on this server yet. Free play is, and trades made in it are
            committed the same way.
          </p>
        ) : (
          !closed && <p className="dim">Entries are closed for this season. Free play is always open.</p>
        )}

        {/* The front page is the summary. Everything else about the season —
            the full board, every trader's numbers — is one click away rather
            than duplicated here. */}
        <p>
          <a href="/season" className="ghost-link">
            Full standings and rules
          </a>
        </p>

        <p>
          <small className="mono">ruleset {season.rulesetHash.slice(0, 16)}…</small>
        </p>
      </div>
    </section>
  );
}

/** A payout as a share of the largest one, for the bar width. */
function share(lamports: string, season: Ranked): number {
  const top = season.payouts.reduce((max, payout) => {
    const value = BigInt(payout.lamports);
    return value > max ? value : max;
  }, 1n);
  const ratio = Number((BigInt(lamports) * 100n) / top);
  return Math.max(6, Math.min(100, ratio));
}
