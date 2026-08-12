'use client';

import { useEffect, useState } from 'react';

/**
 * A trader's public record.
 *
 * The number that matters is not the profit, it is how much of the record is
 * committed on chain. A season with trades and no commitments is a season
 * nobody can check, so that is shown as a meter rather than buried in a
 * sentence: the record's whole claim is that it can be verified, and the page
 * should look like it means it.
 *
 * Built from the same terminal pieces as the rest of the site — the window bar,
 * the big stat row — because a plain card read as an afterthought next to pages
 * that did not.
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
  if (season.freePlay) return 'free play';
  if (season.ranked) return 'ranked season';
  return 'past season';
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
    <div className="record-stack">
      {profile.seasons.map((season) => (
        <SeasonCard key={season.seasonId} season={season} />
      ))}

      <p className="dim record-check">
        <a href={`/verify?trader=${encodeURIComponent(profile.trader)}`}>Check this record yourself</a>
        . The verifier runs in your browser against an RPC you choose. Nothing on this page is
        taken on our word.
      </p>
    </div>
  );
}

export function SeasonCard({ season }: { season: SeasonRow }) {
  const negative = season.netPnl.startsWith('-');
  const committedPct =
    season.trades === 0 ? 0 : Math.round((season.committedTrades / season.trades) * 100);
  const fullyCommitted = season.committedTrades >= season.trades && season.trades > 0;

  return (
    <section aria-label={laneLabel(season)} className="term record-card">
      <div className="term-bar">
        <span className="prompt">~/record</span>
        <span>{laneLabel(season)}</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="term-body">
        <div className="stat-row record-stats">
          <div className="stat">
            <span className="k">Profit and loss</span>
            <span className={`v hero ${season.trades === 0 ? 'dim' : negative ? 'loss' : 'gain'}`}>
              {season.netPnl.startsWith('-') ? '' : '+'}
              {sol(season.netPnl)}
              <span className="unit"> SOL</span>
            </span>
          </div>
          <div className="stat">
            <span className="k">Win rate</span>
            <span className="v">
              {season.winRateBps === null ? '—' : `${(season.winRateBps / 100).toFixed(0)}%`}
            </span>
          </div>
          <div className="stat">
            <span className="k">Trades</span>
            <span className="v">{season.trades}</span>
          </div>
          <div className="stat">
            <span className="k">Closed</span>
            <span className="v">{season.roundTrips}</span>
          </div>
        </div>

        {/* The claim the whole page rests on, shown rather than asserted. */}
        <div className="commit-meter">
          <div className="commit-head">
            <span className="k">On chain</span>
            <span className={`mono ${fullyCommitted ? 'gain' : 'dim'}`}>
              {fullyCommitted
                ? 'fully committed'
                : `${season.committedTrades} of ${season.trades} trades`}
            </span>
          </div>
          <div className="commit-track" aria-hidden="true">
            <span className="commit-fill" style={{ width: `${committedPct}%` }} />
          </div>
          <p className="dim commit-note">
            {fullyCommitted
              ? 'Every trade in this record is on Solana and can be checked by anyone.'
              : 'Trades not yet committed cannot be checked. They are committed in batches, so recent ones may still be waiting.'}
          </p>
        </div>
      </div>
    </section>
  );
}
