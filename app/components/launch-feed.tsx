'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Newly launched tokens, and search over them.
 *
 * The first thing a visitor sees, so it has to work before they have a wallet.
 */

interface Launch {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  launchedAt: number;
}

function age(launchedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - launchedAt);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function LaunchFeedList() {
  const [launches, setLaunches] = useState<Launch[] | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const load = useCallback(async (search: string) => {
    setSearching(true);
    try {
      const url = search ? `/api/launches?q=${encodeURIComponent(search)}` : '/api/launches';
      const body = (await (await fetch(url)).json()) as { launches: Launch[] };
      setLaunches(body.launches);
    } catch {
      setLaunches([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  // Debounced, so typing a mint address does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <section aria-label="Tokens">
      <label>
        Search
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, symbol, or paste a mint address"
        />
      </label>

      {launches === null ? (
        <p>Loading…</p>
      ) : launches.length === 0 ? (
        <p>
          {query
            ? 'Nothing matches that.'
            : 'No launches yet. The feed fills as tokens are created.'}
        </p>
      ) : (
        <ul>
          {launches.map((launch) => (
            <li key={launch.mint}>
              <a href={`/t/${launch.mint}`}>
                <strong>{launch.symbol}</strong> {launch.name}
              </a>{' '}
              <span>{age(launch.launchedAt)}</span>
            </li>
          ))}
        </ul>
      )}

      {searching && <span aria-live="polite" />}
    </section>
  );
}
