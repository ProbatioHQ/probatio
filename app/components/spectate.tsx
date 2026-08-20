'use client';

import { useEffect, useRef, useState } from 'react';
import { imageSrc } from '@/lib/image-src';

/**
 * Fills arriving while you watch.
 *
 * Either one trader, or everybody the reader follows. The panel is the same
 * both ways because the events are, so this takes the mode and nothing else
 * changes.
 *
 * The point of watching somebody trade here rather than anywhere else is that
 * every row is a sealed fill: the price impact and the latency shown are the
 * ones that were recorded with it, not a summary written afterwards. So the
 * row shows those two numbers rather than hiding them behind a total.
 */

interface Fill {
  id: number;
  trader: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
  side: 'buy' | 'sell';
  solAmount: string;
  tokenAmount: string;
  priceImpactBps: number;
  latencyMs: number;
  createdAt: number;
}

const LAMPORTS = 1_000_000_000;
/** Enough to scroll back through, bounded so a long watch cannot grow forever. */
const MAX_ROWS = 60;

function sol(lamports: string): string {
  const value = Number(BigInt(lamports)) / LAMPORTS;
  return value >= 100 ? value.toFixed(1) : value.toFixed(3);
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

export function Spectate({ trader, mode }: { trader?: string; mode: 'trader' | 'following' }) {
  const [fills, setFills] = useState<Fill[]>([]);
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /*
   * Ids that arrived on the last event.
   *
   * A fill landing while somebody is watching should be visible as an arrival,
   * not just as a row that is suddenly there. Held for a moment so the row can
   * play its entrance, then dropped, because a permanent highlight is not an
   * arrival, it is decoration.
   */
  const [fresh, setFresh] = useState<ReadonlySet<number>>(() => new Set());
  const [landed, setLanded] = useState(0);
  /*
   * Ids already on screen.
   *
   * A reconnect replays its backfill, and without this the same fills would be
   * prepended a second time. Kept in a ref rather than state because it is
   * consulted inside the event handler and must not make the panel re-render.
   */
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    const query = mode === 'following' ? 'feed=following' : `trader=${encodeURIComponent(trader ?? '')}`;
    const source = new EventSource(`/api/spectate/stream?${query}`);

    source.addEventListener('ready', () => setLive(true));
    source.addEventListener('error', () => setLive(false));
    source.addEventListener('fills', (event) => {
      let batch: Fill[];
      try {
        batch = JSON.parse((event as MessageEvent<string>).data) as Fill[];
      } catch {
        return;
      }
      const arrived = batch.filter((fill) => !seen.current.has(fill.id));
      if (arrived.length === 0) return;
      for (const fill of arrived) seen.current.add(fill.id);
      setLive(true);
      setFresh(new Set(arrived.map((fill) => fill.id)));
      setLanded((count) => count + arrived.length);
      // Newest at the top, and bounded: a panel left open for an evening should
      // not become the reason a tab is using half a gigabyte.
      setFills((current) => [...arrived.reverse(), ...current].slice(0, MAX_ROWS));
    });

    return () => source.close();
  }, [trader, mode]);

  // The ages are relative, so they have to be recomputed even when nothing
  // arrives, or a quiet minute leaves every row claiming to be seconds old.
  useEffect(() => {
    // Ticks the relative times. Ten seconds, because a row that says 40s for a
    // minute and a half reads as a screenshot rather than a feed.
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = setTimeout(() => setFresh(new Set()), 1_400);
    return () => clearTimeout(timer);
  }, [fresh]);

  return (
    <section className="spectate">
      <div className="spectate-head">
        <span className={live ? 'spectate-live on' : 'spectate-live'}>
          <i aria-hidden="true" />
          {live ? 'Live' : 'Reconnecting'}
        </span>
        <span className="spectate-title">
          {mode === 'following' ? 'Fills from traders you follow' : 'Fills as they land'}
        </span>

        {/* What has arrived while this page has been open, which is the one
            number that says the panel is doing something. */}
        {landed > 0 && (
          <span className="spectate-count">
            {landed} {landed === 1 ? 'fill' : 'fills'} since you opened this
          </span>
        )}
      </div>

      {fills.length === 0 ? (
        <p className="dim spectate-empty">
          {mode === 'following'
            ? 'Nothing yet. Follow a few traders and their fills will appear here as they happen.'
            : 'Nothing yet. Any fill this trader makes will appear here as it lands.'}
        </p>
      ) : (
        <ol className="spectate-list">
          {fills.map((fill) => {
            const art = imageSrc(fill.image);
            return (
              <li
                key={fill.id}
                className={fresh.has(fill.id) ? 'spectate-row fresh' : 'spectate-row'}
              >
                <span className={fill.side === 'buy' ? 'spectate-side buy' : 'spectate-side sell'}>
                  {fill.side}
                </span>

                <a className="spectate-token" href={`/t/${fill.mint}`}>
                  {art ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={art} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="spectate-art" aria-hidden="true" />
                  )}
                  <span className="spectate-name">{fill.name ?? short(fill.mint)}</span>
                  {fill.symbol && <span className="spectate-ticker">${fill.symbol}</span>}
                </a>

                <span className="spectate-size">{sol(fill.solAmount)} SOL</span>

                {/* The two numbers that make a fill here different from a fill
                    anywhere else, shown rather than summarised away. */}
                <span className="spectate-detail">
                  {(fill.priceImpactBps / 100).toFixed(2)}% impact
                  <span className="follow-dot">·</span>
                  {fill.latencyMs}ms
                </span>

                {mode === 'following' && (
                  <a className="spectate-who" href={`/p/${fill.trader}`}>
                    {short(fill.trader)}
                  </a>
                )}

                <span className="spectate-ago">{ago(fill.createdAt, now)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
