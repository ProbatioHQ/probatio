'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Newly launched tokens, arriving as they launch.
 *
 * The first thing a visitor sees, so it has to work before they have a wallet,
 * and it has to be moving — a feed of live launches that only changes when you
 * reload is indistinguishable from a list.
 *
 * Loaded over HTTP once, then kept current by a server-sent stream. Both, not
 * either: the stream only carries what happens after you connect, so without
 * the fetch a new arrival would sit in front of an empty box waiting for
 * somebody to launch something.
 */

interface Launch {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  launchedAt: number;
  image: string | null;
}

/** Kept bounded. A feed left open all day should not grow without limit. */
const MAX_ROWS = 60;

function age(launchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000) - launchedAt);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * A token with no picture still needs to occupy the same space as one that has
 * it, or the feed reflows every time a document resolves. Four bars keyed off
 * the mint: stable, drawn, and never an empty grey square.
 */
function MintMark({ mint }: { mint: string }) {
  const bars = useMemo(
    () => [0, 1, 2, 3].map((i) => (mint.charCodeAt(i * 4) * 7 + mint.charCodeAt(i * 4 + 1)) % 100),
    [mint],
  );
  return (
    <span className="token-mark" aria-hidden="true">
      {bars.map((height, index) => (
        <i key={index} style={{ height: `${25 + (height / 100) * 75}%` }} />
      ))}
    </span>
  );
}

function TokenImage({ launch }: { launch: Launch }) {
  const [broken, setBroken] = useState(false);

  if (!launch.image || broken) return <MintMark mint={launch.mint} />;

  return (
    // Not next/image: these are arbitrary hosts chosen by whoever launched the
    // token, and putting them through the optimiser would mean this server
    // fetching a stranger's URL on demand. Rendered by the browser, sandboxed
    // by the browser, and never sent a referrer.
    <img
      className="token-img"
      src={launch.image}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

export function LaunchFeedList() {
  const [launches, setLaunches] = useState<Launch[] | null>(null);
  const [query, setQuery] = useState('');
  const [live, setLive] = useState(false);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const searching = query.trim().length > 0;
  const searchingRef = useRef(searching);
  searchingRef.current = searching;

  const load = useCallback(async (search: string) => {
    try {
      const url = search ? `/api/launches?q=${encodeURIComponent(search)}` : '/api/launches';
      const body = (await (await fetch(url)).json()) as { launches: Launch[] };
      setLaunches(body.launches);
    } catch {
      setLaunches([]);
    }
  }, []);

  // Debounced, so typing a mint address does not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim()), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  // Ages are relative, so they have to be recomputed rather than rendered once.
  // One timer for the whole list rather than one per row.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/launches/stream');

    source.addEventListener('ready', () => setLive(true));

    source.addEventListener('launches', (event) => {
      // While somebody is searching, new launches would shove their results
      // around. The stream stays connected and its arrivals are dropped.
      if (searchingRef.current) return;

      const incoming = JSON.parse((event as MessageEvent<string>).data) as Launch[];
      setLaunches((current) => {
        const existing = current ?? [];
        const seen = new Set(existing.map((launch) => launch.mint));
        // A reconnecting socket replays recent history, so repeats are normal.
        const fresh = incoming.filter((launch) => !seen.has(launch.mint));
        if (fresh.length === 0) return current;

        setArrived((was) => {
          const next = new Set(was);
          for (const launch of fresh) next.add(launch.mint);
          return next;
        });

        return [...fresh, ...existing].slice(0, MAX_ROWS);
      });
    });

    source.onerror = () => setLive(false);

    return () => source.close();
  }, []);

  // The highlight on a new row is a moment, not a state. Cleared shortly after
  // so a row that arrived a minute ago does not stay lit.
  useEffect(() => {
    if (arrived.size === 0) return;
    const timer = setTimeout(() => setArrived(new Set()), 2_000);
    return () => clearTimeout(timer);
  }, [arrived]);

  // Pictures resolve after the token exists, so rows that arrived over the
  // stream without one ask again a moment later rather than staying blank
  // until a reload.
  useEffect(() => {
    if (!launches) return;
    const missing = launches.filter((launch) => !launch.image).map((launch) => launch.mint);
    if (missing.length === 0) return;

    const timer = setTimeout(() => {
      void fetch(`/api/token-images?mints=${missing.slice(0, 60).join(',')}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { images: Record<string, string> } | null) => {
          if (!body || Object.keys(body.images).length === 0) return;
          setLaunches((current) =>
            current
              ? current.map((launch) =>
                  launch.image ? launch : { ...launch, image: body.images[launch.mint] ?? null },
                )
              : current,
          );
        })
        .catch(() => undefined);
    }, 3_000);

    return () => clearTimeout(timer);
  }, [launches]);

  return (
    <section id="feed" aria-label="Tokens" className="term">
      <div className="term-bar">
        <span className="prompt">~/feed</span>
        <span>pump.fun launches</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="term-body">
        <div className="season-head">
          <h2>Live launches</h2>
          <span className={live ? 'pill live' : 'pill'}>
            {live ? 'streaming' : 'reconnecting'}
          </span>
        </div>

        <label className="field">
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, symbol, or paste a mint address"
          />
        </label>

        {launches === null ? (
          <p className="dim">Loading…</p>
        ) : launches.length === 0 ? (
          <p className="dim">
            {searching
              ? 'Nothing matches that.'
              : 'No launches yet. The feed fills as tokens are created.'}
          </p>
        ) : (
          <ul className="bare scroller feed">
            {launches.map((launch) => (
              <li
                key={launch.mint}
                className={arrived.has(launch.mint) ? 'feed-row fresh' : 'feed-row'}
              >
                <a href={`/t/${launch.mint}`}>
                  <TokenImage launch={launch} />
                  <span className="feed-name">
                    <strong>{launch.symbol || '???'}</strong>
                    <span className="dim">{launch.name}</span>
                  </span>
                  <span className="feed-age mono dim">{age(launch.launchedAt, now)}</span>
                  <span className="feed-go" aria-hidden="true">
                    trade
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
