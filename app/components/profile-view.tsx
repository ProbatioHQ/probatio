'use client';

import { useEffect, useState } from 'react';

/**
 * A trader's public record.
 *
 * The number that matters is not the profit, it is how much of the record is
 * committed on chain. A season with trades and no commitments is a season
 * nobody can check, and that is said plainly rather than left for somebody to
 * work out.
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

  if (failed) return <p>Could not load this record.</p>;
  if (!profile) return <p>Loading…</p>;

  if (!profile.exists) {
    return <p>This wallet has never traded here.</p>;
  }

  return (
    <>
      {profile.seasons.map((season) => (
        <section key={season.seasonId} aria-label={`Season ${season.seasonId}`}>
          <h2>{season.freePlay ? 'Free play' : season.ranked ? 'Ranked season' : 'Past season'}</h2>
          <dl>
            <dt>Trades</dt>
            <dd>{season.trades}</dd>
            <dt>Closed positions</dt>
            <dd>{season.roundTrips}</dd>
            <dt>Win rate</dt>
            <dd>{season.winRateBps === null ? '—' : `${(season.winRateBps / 100).toFixed(1)}%`}</dd>
            <dt>Profit and loss</dt>
            <dd>{sol(season.netPnl)} SOL</dd>
            <dt>Committed on chain</dt>
            <dd>
              {season.committedTrades} of {season.trades} trades
              {season.committedBatches > 0 && ` in ${season.committedBatches} batches`}
            </dd>
          </dl>

          {season.committedTrades < season.trades && (
            <p>
              Trades not yet committed cannot be checked by anyone. They are committed in
              batches, so recent ones may still be waiting.
            </p>
          )}
        </section>
      ))}

      <p>
        <a href={`/verify?trader=${encodeURIComponent(profile.trader)}`}>
          Check this record yourself
        </a>{' '}
        — the verifier runs in your browser against an RPC you choose. Nothing on this page
        is taken on our word.
      </p>
    </>
  );
}
