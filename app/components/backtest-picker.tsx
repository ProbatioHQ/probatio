'use client';

import { useEffect, useRef, useState } from 'react';
import { RuleBacktest } from '@/components/rule-backtest';
import { imageSrc } from '@/lib/image-src';

/**
 * Choosing a token to replay a rule against.
 *
 * The panel itself already sits on every token page, which is where somebody
 * uses it: they are looking at a chart, they wonder what a rule would have
 * done, and it is underneath. This page is for the other direction, when the
 * rule is the thing they came with and the token is the variable.
 *
 * It is also the only address the feature has. A panel buried on a token page
 * cannot be linked to from a roadmap, a post or a message, and a feature nobody
 * can link to is a feature nobody finds.
 *
 * Search rather than a list, because the useful token is rarely one of the
 * eight moving hardest right now. `/api/launches` already turns a word into
 * mints, reaching past what this site has seen into an outside index, so the
 * same query that finds something to trade finds something to replay.
 */

interface Found {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  marketCap: string | null;
}

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A market cap, from lamports into dollars.
 *
 * The search returns caps in lamports, because the feed carries them that way
 * and converts for display. It ships the rate it used alongside them for
 * exactly this, and the first version of this ignored it: dividing by a billion
 * gives SOL, and putting a dollar sign in front of SOL is off by the price of
 * SOL. Ninety-three times too small, and not obviously wrong to look at, which
 * is the worst way for a number to be wrong.
 *
 * Nothing is shown at all without a rate, since a figure that might be in
 * either unit is worse than a blank.
 */
function cap(lamports: string | null, solUsd: number | null): string {
  const value = Number(lamports);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (solUsd === null || !Number.isFinite(solUsd) || solUsd <= 0) return '';

  const usd = (value / 1e9) * solUsd;
  // Billions, because the largest results really are that big and "$2155.7M"
  // is a number somebody has to stop and count the digits of.
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
}

/**
 * One result row.
 *
 * Its own component because of the picture, which needs a piece of state per
 * row and so cannot live inside a map in the parent.
 *
 * Both halves of that picture were missing when this shipped, and both are
 * mistakes the rest of the site had already made and fixed. `imageSrc` re-points
 * a dead IPFS gateway at a live one, which is one in twelve tokens rather than a
 * rare case. `onError` catches everything else: a host that no longer resolves
 * leaves a broken-image icon in the row and a red line in the console for every
 * render, and a plain empty square is both quieter and honest.
 */
function Hit({
  token,
  solUsd,
  onPick,
}: {
  token: Found;
  solUsd: number | null;
  onPick: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const src = imageSrc(token.image);

  return (
    <button type="button" className="bp-hit" onClick={onPick}>
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="bp-img"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="bp-img bp-img-none" />
      )}
      <span className="bp-name">
        {token.symbol || token.name}
        <span className="bp-full">{token.name}</span>
      </span>
      <span className="bp-cap">{cap(token.marketCap, solUsd)}</span>
    </button>
  );
}

export function BacktestPicker() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Found[]>([]);
  const [chosen, setChosen] = useState<Found | null>(null);
  const [searching, setSearching] = useState(false);
  // Shipped with the results, and the only thing that turns them into dollars.
  const [solUsd, setSolUsd] = useState<number | null>(null);
  /*
   * Whether the last search failed, as opposed to finding nothing.
   *
   * Opposite facts. A rate limit, a timeout or a five hundred would otherwise
   * come back through the same path as an empty list and be reported as
   * "nothing found for that", which is a claim about the token rather than
   * about us and happens to be untrue.
   */
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const text = query.trim();
    if (text === '') {
      setResults([]);
      return;
    }

    /*
     * A mint is not a search. Pasting an address means the token is already
     * known, so it opens rather than asking an index about a word that happens
     * to be forty-four characters long.
     */
    if (MINT.test(text)) {
      // Shortened, because the whole address as a name is forty-four characters
      // of noise in a sentence that is otherwise four words long.
      const short = `${text.slice(0, 4)}…${text.slice(-4)}`;
      setChosen({ mint: text, name: short, symbol: '', image: null, marketCap: null });
      setResults([]);
      return;
    }

    // Typing is faster than an index answers, so a keystroke waits to see if
    // another one follows, and an answer that arrives after a newer question
    // was asked is dropped rather than shown.
    const ticket = ++latest.current;
    const timer = setTimeout(() => {
      setSearching(true);
      setFailed(false);
      fetch(`/api/launches?q=${encodeURIComponent(text)}&limit=8`)
        .then(async (response) => {
          // A refusal is not an empty result, and reading one as the other is
          // how a search that never ran reports that a token does not exist.
          if (!response.ok) throw new Error(String(response.status));
          return (await response.json()) as { results?: Found[]; solUsd?: number };
        })
        .then((body) => {
          if (ticket !== latest.current) return;
          setResults(body.results ?? []);
          setSolUsd(typeof body.solUsd === 'number' ? body.solUsd : null);
        })
        .catch(() => {
          if (ticket !== latest.current) return;
          setResults([]);
          setFailed(true);
        })
        .finally(() => {
          if (ticket === latest.current) setSearching(false);
        });
    }, 260);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="bp">
      <label className="bp-search">
        <span className="bp-caption">Token</span>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setChosen(null);
          }}
          placeholder="Search by name, or paste a mint"
          spellCheck={false}
          autoComplete="off"
        />
      </label>

      {chosen === null && results.length > 0 && (
        <div className="bp-hits">
          {results.map((token) => (
            <Hit
              key={token.mint}
              token={token}
              solUsd={solUsd}
              onPick={() => {
                setChosen(token);
                setResults([]);
              }}
            />
          ))}
        </div>
      )}

      {chosen === null && query.trim() !== '' && results.length === 0 && !searching && (
        <p className="bp-said">
          {failed
            ? 'The search could not be reached just now. Try again, or paste the mint.'
            : 'Nothing found for that. Paste the mint if you have it.'}
        </p>
      )}

      {chosen && (
        <>
          <p className="bp-chosen">
            Replaying <strong>{chosen.symbol || chosen.name}</strong>
            <button type="button" className="linklike bp-clear" onClick={() => setChosen(null)}>
              change
            </button>
            {/* Somewhere to go once the answer is in, since the next thing
                anybody wants is the chart it came from. */}
            <a className="bp-open" href={`/t/${chosen.mint}`}>
              open the token
            </a>
          </p>
          {/*
            Keyed on the mint so changing token throws the panel away.

            Without it React keeps the same instance, the result it is holding
            survives, and the previous token's figures sit under the new token's
            name until somebody presses replay. Which is a wrong answer that
            looks exactly like a right one.
          */}
          <RuleBacktest key={chosen.mint} mint={chosen.mint} />
        </>
      )}
    </div>
  );
}
