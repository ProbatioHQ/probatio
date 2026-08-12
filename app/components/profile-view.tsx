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
        const fullyCommitted = season.committedTrades >= season.trades && season.trades > 0;

        return (
          <section key={season.seasonId} aria-label={laneLabel(season)} className="panel">
            <div className="panel-head">
              <h2>{laneLabel(season)}</h2>
            </div>

            <div className="readout">
              <div className="readout-row">
                <span className="k">Profit and loss</span>
                <span className={`v ${season.trades === 0 ? '' : negative ? 'loss' : 'gain'}`}>
                  {negative ? '' : '+'}
                  {sol(season.netPnl)} SOL
                </span>
              </div>
              <div className="readout-row">
                <span className="k">Win rate</span>
                <span className="v">
                  {season.winRateBps === null ? 'n/a' : `${(season.winRateBps / 100).toFixed(0)}%`}
                </span>
              </div>
              <div className="readout-row">
                <span className="k">Trades</span>
                <span className="v">{season.trades}</span>
              </div>
              <div className="readout-row">
                <span className="k">Closed positions</span>
                <span className="v">{season.roundTrips}</span>
              </div>
              <div className="readout-row">
                <span className="k">On chain</span>
                <span className={`v ${fullyCommitted ? 'gain' : ''}`}>
                  {fullyCommitted
                    ? 'all committed'
                    : `${season.committedTrades} of ${season.trades}`}
                </span>
              </div>
            </div>

            {!fullyCommitted && (
              <p className="dim panel-note">
                Trades not yet committed cannot be checked. They are committed in batches, so
                recent ones may still be waiting.
              </p>
            )}
          </section>
        );
      })}

      <p className="dim">
        <a href={`/verify?trader=${encodeURIComponent(profile.trader)}`}>Check this record yourself</a>
        . The verifier runs in your browser against an RPC you choose. Nothing here is taken on
        our word.
      </p>
    </div>
  );
}
