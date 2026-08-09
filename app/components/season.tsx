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
    <section aria-label="Season">
      <h2>{season.name}</h2>

      {season.status === 'pending' && (
        <p>Opens {new Date(season.startsAt).toLocaleString()}.</p>
      )}

      {closed && <p>This season is over.</p>}

      <dl>
        <dt>Prize pool</dt>
        <dd>{sol(season.potLamports)} SOL</dd>
        <dt>Entrants</dt>
        <dd>{season.entrants}</dd>
        {season.entryClosesInMs !== null && (
          <>
            <dt>Entry closes in</dt>
            <dd>{remaining(season.entryClosesInMs)}</dd>
          </>
        )}
      </dl>

      {season.payouts.length > 0 && (
        <>
          <h3>Paid now</h3>
          <ol>
            {season.payouts.map((payout) => (
              <li key={payout.place}>
                {ORDINALS[payout.place - 1] ?? `${payout.place}th`} — {sol(payout.lamports)} SOL
              </li>
            ))}
          </ol>
        </>
      )}

      {season.nextBand && !closed && (
        <p>
          {season.nextBand.entriesAway} more{' '}
          {season.nextBand.entriesAway === 1 ? 'entry' : 'entries'} and the top{' '}
          {season.nextBand.places} all get paid.
        </p>
      )}

      <p>
        Highest return wins. Everyone starts with the same balance and the same fill conditions.
      </p>

      {season.entered ? (
        <p>You are entered.</p>
      ) : season.status === 'entry_open' ? (
        <EnterSeason />
      ) : (
        !closed && <p>Entries are closed for this season. Free play is always open.</p>
      )}

      <p>
        <small>Ruleset {season.rulesetHash.slice(0, 16)}…</small>
      </p>
    </section>
  );
}
