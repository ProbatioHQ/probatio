'use client';

import { useCallback, useEffect, useState } from 'react';
import { Sprout, age, freshAge } from '@/components/sprout';
import { imageSrc } from '@/lib/image-src';

/**
 * What is moving, as cards.
 *
 * The terminal is a firehose of thirty-second-old launches, which is the right
 * shape for somebody hunting and the wrong one for somebody arriving. This is
 * the other half: a page you can open cold and see what is worth a look.
 *
 * The ranking is not this site's, and the page says so rather than letting the
 * numbers imply otherwise. Candidates come from pump.fun's own listing and the
 * hour's move from DEX Screener, because there is price history here for only
 * the couple of hundred tokens somebody has already opened.
 */

interface Mover {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  creator: string;
  createdAt: number;
  marketCapUsd: number;
  changeH1: number | null;
  volumeH24: number;
  description: string | null;
  twitter: string | null;
  website: string | null;
  complete: boolean;
  spark: number[];
}

function usd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(0)}`;
}

/** A creator's key as a handle, the way every other client shows it. */
function handle(creator: string): string {
  return creator.slice(0, 8).toLowerCase();
}

/**
 * The line over the art.
 *
 * Normalised to its own range rather than to a shared scale: this says the
 * shape of the hour, not how one token's price compares to another's, and
 * every card would otherwise be a flat line except the largest.
 */
function Spark({ points, up }: { points: number[]; up: boolean }) {
  if (points.length < 3) return null;

  const low = Math.min(...points);
  const high = Math.max(...points);
  const span = high - low || 1;
  const W = 120;
  const H = 34;

  const d = points
    .map((value, i) => {
      const x = (W * i) / (points.length - 1);
      const y = H - ((value - low) / span) * H;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={up ? 'var(--accent)' : 'var(--loss)'} strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Card({ token, now }: { token: Mover; now: number }) {
  const [broken, setBroken] = useState(false);
  const src = imageSrc(token.image);
  const up = (token.changeH1 ?? 0) >= 0;

  return (
    <a className="mover" href={`/t/${token.mint}`}>
      <span className="mover-art">
        {src && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
            onError={() => setBroken(true)} />
        ) : (
          <span className="mover-art-blank" aria-hidden="true" />
        )}
        <Spark points={token.spark} up={up} />
      </span>

      <span className="mover-name">{token.name}</span>
      <span className="mover-ticker">${token.symbol}</span>

      <span className="mover-figures">
        <span className="mover-cap">{usd(token.marketCapUsd)}</span>
        <span className="mover-mc">MC</span>
        {token.changeH1 !== null && (
          <span className={up ? 'mover-change gain' : 'mover-change loss'}>
            {up ? '+' : ''}
            {token.changeH1.toFixed(0)}%
          </span>
        )}
      </span>

      <span className="mover-by">
        <span className="mover-creator">{handle(token.creator)}</span>
        <span className={freshAge(token.createdAt, now) ? 'mover-age new' : 'mover-age'}>
          <Sprout />
          {age(token.createdAt, now)}
        </span>
      </span>
    </a>
  );
}

export function ExploreBoard() {
  const [movers, setMovers] = useState<Mover[] | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback((which: number) => {
    void fetch(`/api/explore?page=${which}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { movers?: Mover[]; pages?: number } | null) => {
        if (!body?.movers) {
          setFailed(true);
          return;
        }
        setFailed(false);
        setMovers(body.movers);
        if (body.pages) setPages(body.pages);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load(page);
    // The ranking is cached for a minute upstream, so asking faster than that
    // would be asking this server to hand back the same answer.
    const timer = setInterval(() => load(page), 60_000);
    return () => clearInterval(timer);
  }, [load, page]);

  // Ages are relative, so one timer for the page rather than one per card.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  if (failed && !movers) {
    return (
      <p className="dim">
        The services this page ranks from could not be reached. The terminal does not depend on
        them and is unaffected.
      </p>
    );
  }
  if (!movers) return <p className="dim">Loading…</p>;
  if (movers.length === 0) return <p className="dim">Nothing is moving enough to list right now.</p>;

  return (
    <>
      <div className="movers">
        {movers.map((token) => (
          <Card key={token.mint} token={token} now={now} />
        ))}
      </div>

      {pages > 1 && (
        <nav className="pager" aria-label="More movers">
          {Array.from({ length: pages }, (_, index) => index + 1).map((which) => (
            <button
              key={which}
              type="button"
              className={which === page ? 'page-btn on' : 'page-btn'}
              aria-current={which === page ? 'page' : undefined}
              onClick={() => {
                setPage(which);
                // Back to the first row, or turning the page leaves you halfway
                // down a list you have not seen the top of.
                setMovers(null);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              {which}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
