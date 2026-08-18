'use client';

import { useEffect, useState } from 'react';

/**
 * A trader's public record.
 *
 * Read top to bottom: each figure on its own line, label on the left, value on
 * the right, so it scans in one pass. The number that matters is not the profit,
 * it is how much of the record is committed on chain. A season with trades and no
 * commitments is one nobody can check, so that line is here and said plainly.
 */

interface SeasonRow {
  seasonId: number;
  ranked: boolean;
  freePlay: boolean;
  trades: number;
  roundTrips: number;
  winRateBps: number | null;
  netPnl: string;
  committedBatches: number;
  committedTrades: number;
}

interface Profile {
  trader: string;
  display: string;
  exists: boolean;
  seasons: SeasonRow[];
  proof?: string;
}

function sol(lamports: string): string {
  const value = BigInt(lamports);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000_000n;
  const fraction = ((absolute % 1_000_000_000n) * 100n) / 1_000_000_000n;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

function laneLabel(season: SeasonRow): string {
  if (season.freePlay) return 'Free play';
  if (season.ranked) return 'Ranked season';
  return 'Past season';
}

export function ProfileView({ pubkey }: { pubkey: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/profile?trader=${encodeURIComponent(pubkey)}`)
      .then((response) => response.json() as Promise<Profile>)
      .then((body) => {
        if (!cancelled) setProfile(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  if (failed) return <p className="dim">Could not load this record.</p>;
  if (!profile) return <p className="dim">Loading…</p>;

  if (!profile.exists) {
    return <p className="dim">This wallet has never traded here.</p>;
  }

  return (
    <div className="stack">
      {profile.seasons.map((season) => {
        const negative = season.netPnl.startsWith('-');
        const traded = season.trades > 0;
        const wins =
          season.winRateBps === null ? null : Math.round((season.winRateBps / 10_000) * season.roundTrips);

        return (
          <section key={season.seasonId} aria-label={laneLabel(season)} className="record">
            <div className="record-head">
              <span className="record-lane">{laneLabel(season)}</span>
              {traded && (
                <span className={negative ? 'record-tag loss' : 'record-tag gain'}>
                  {negative ? 'down' : 'up'}
                </span>
              )}
            </div>

            {/* The one figure somebody came to see, at the size that says so. */}
            <div className={`record-pnl ${!traded ? 'flat' : negative ? 'loss' : 'gain'}`}>
              {traded && !negative && '+'}
              {sol(season.netPnl)}
              <span className="record-unit">SOL</span>
            </div>

            <div className="record-grid">
              <div className="record-stat">
                <span className="k">Win rate</span>
                <span className="v">
                  {season.winRateBps === null ? '—' : `${(season.winRateBps / 100).toFixed(0)}%`}
                </span>
                {wins !== null && season.roundTrips > 0 && (
                  <span className="sub">
                    {wins}W · {season.roundTrips - wins}L
                  </span>
                )}
              </div>
              <div className="record-stat">
                <span className="k">Closed</span>
                <span className="v">{season.roundTrips}</span>
                <span className="sub">round trips</span>
              </div>
              <div className="record-stat">
                <span className="k">Fills</span>
                <span className="v">{season.trades}</span>
                <span className="sub">buys and sells</span>
              </div>
            </div>

            {!traded && (
              <p className="dim record-note">Nothing traded here yet.</p>
            )}
          </section>
        );
      })}

      {/*
        Nothing here claims to be checkable against a chain.
        
        The page used to count how much of the record had been committed and
        offer a verifier to check it against Solana. Neither is running: the
        program those commits call is not deployed, so the count was always zero
        of everything and the offer was to check nothing against nothing. What
        the record is today is what this server recorded as each fill happened,
        and saying that plainly is worth more than an invitation that leads
        somewhere empty.
      */}
      <p className="dim">
        Every fill is recorded as it happens, at the price the market was at that moment, and
        cannot be edited afterwards.
      </p>
    </div>
  );
}
