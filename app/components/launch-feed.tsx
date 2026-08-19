'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sprout, age, freshAge } from '@/components/sprout';
import { imageSrc } from '@/lib/image-src';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  matchesFilters,
  type Filters,
} from '@/lib/feed-filters';

/**
 * The launch feed, in three lanes.
 *
 * One list ordered by age was the wrong shape. Nobody trades pump.fun that way
 * — they watch what just launched, what is close to graduating, and what
 * already has, and those are three different decisions. So they are three
 * columns, and a token moves between them as its curve fills.
 *
 * Two shapes, one engine. The front page gets a preview: enough to show the
 * thing is alive and moving, and a way through to the real one. `/feed` gets
 * the terminal — more rows, filters, and room for the numbers to be readable.
 * Running both off one component means the preview can never drift from the
 * page it is advertising.
 *
 * Loaded over HTTP once, then kept current by a server-sent stream carrying
 * both new launches and curve progress. Both, not either: the stream only
 * carries what happens after you connect, so without the fetch a new arrival
 * would sit in front of three empty boxes.
 */

interface Token {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  launchedAt: number;
  image: string | null;
  /** Null when nothing has read this curve yet, which is not the same as zero. */
  progressBps: number | null;
  /** Lamports, as a digit string. Null when the curve has not been read yet. */
  marketCap: string | null;
  complete: boolean;
  /** A floor on how many tokens this creator has launched. */
  creatorLaunches?: number;
}

interface Lanes {
  new: Token[];
  bonding: Token[];
  bonded: Token[];
}

type LaneKey = keyof Lanes;

/**
 * `short` is what the phone's three buttons say.
 *
 * A column heading has a whole column to explain itself, so "About to bond"
 * and "Bonded" are worth the words there. Three buttons side by side on a
 * 390px screen do not have that room, and these are the names every other
 * pump.fun client uses for the same three piles, so they are the ones somebody
 * arriving already knows.
 */
const LANES: { key: LaneKey; title: string; short: string; prompt: string; blurb: string }[] = [
  { key: 'new', title: 'New', short: 'New', prompt: '~/new', blurb: 'Just created' },
  {
    key: 'bonding',
    title: 'About to bond',
    short: 'Soon',
    prompt: '~/bonding',
    blurb: 'Half the curve sold',
  },
  {
    key: 'bonded',
    title: 'Bonded',
    short: 'Graduated',
    prompt: '~/bonded',
    blurb: 'Graduated to the AMM',
  },
];

/*
 * Kept bounded, but at the server's own ceiling rather than well under it.
 *
 * This was 60 while `/api/launches` will serve 100, so a third of what the
 * database was willing to hand over was left on the table for no reason. Every
 * row is a live DOM node with a picture in it, so this is not free and it does
 * not want to be unbounded; 100 is what the endpoint already caps at, which
 * makes the two agree instead of the client quietly asking for less.
 */
const MAX_ROWS = 100;
/** The preview shows enough to prove it is moving. The terminal shows the feed. */
const PREVIEW_ROWS = 8;

/**
 * One filter set per lane, kept apart on purpose.
 *
 * A trader wants different things from each lane. In the new lane the question
 * is which of a hundred fresh launches is worth a look; in the bonded lane it
 * is which graduated token has held a market cap worth trading. Those are not
 * the same filter, so they are not the same filter set. The panel edits one
 * lane at a time, and each lane's column is filtered by its own.
 */
type LaneFilters = Record<LaneKey, Filters>;

const DEFAULT_LANE_FILTERS: LaneFilters = {
  new: { ...DEFAULT_FILTERS },
  bonding: { ...DEFAULT_FILTERS },
  bonded: { ...DEFAULT_FILTERS },
};

/**
 * A min/max pair, the shape every numeric filter here takes.
 *
 * Empty reads as no bound, which is why the value shown is blank at zero rather
 * than a literal 0 — a floor of zero and no floor are the same thing, and
 * printing the zero invites somebody to think they set one.
 */
function RangeRow({
  label,
  min,
  max,
  onMin,
  onMax,
}: {
  label: string;
  min: number;
  max: number;
  onMin: (value: number) => void;
  onMax: (value: number) => void;
}) {
  const parse = (raw: string): number => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return (
    <div className="filter-range">
      <span className="range-label">{label}</span>
      <div className="range-inputs">
        <input
          type="number"
          min={0}
          placeholder="Min"
          value={min === 0 ? '' : min}
          onChange={(event) => onMin(parse(event.target.value))}
        />
        <input
          type="number"
          min={0}
          placeholder="Max"
          value={max === 0 ? '' : max}
          onChange={(event) => onMax(parse(event.target.value))}
        />
      </div>
    </div>
  );
}

const FILTER_KEY = 'probatio.feed.filters';

/**
 * Market cap, in the currency people actually quote it in.
 *
 * Dollars rather than SOL. "12.3◎" is not how anybody says how big a token is,
 * and a figure nobody reads is a figure nobody uses. Falls back to SOL when no
 * exchange rate can be had, because a figure in the wrong unit is honest and a
 * wrong dollar number is not.
 */
/**
 * What a pump.fun token is worth before anybody has traded it.
 *
 * Every curve starts at the same place: 30 SOL of virtual SOL reserve against
 * 1,073,000,000,000,000 base units of virtual token reserve, with a billion
 * tokens minted. That puts the opening market cap at 30 / 1.073 SOL, and it is
 * the same number for every launch, which is why a wall of fresh tokens on
 * pump.fun all show the same figure.
 *
 * Used when the feed has not read a curve yet. That used to render "n/a", which
 * is both ugly and wrong: the value is not unknown, it is the one every token
 * has until someone buys. The first curve read replaces it with the real
 * number seconds later.
 */
const OPENING_MARKET_CAP = '27959000000';

/**
 * Largest first, with an unpriced token at the bottom.
 *
 * Matches the server's ordering exactly, including where a null cap goes. It
 * did not: this counted a null as the opening market cap, which drops it into
 * the middle of the list, while the API sinks it. The list would have been
 * ordered one way on arrival and reshuffled the moment the first curve update
 * came down the stream.
 */
function byMarketCap(a: Token, b: Token): number {
  if (a.marketCap === null) return b.marketCap === null ? 0 : 1;
  if (b.marketCap === null) return -1;
  const left = BigInt(a.marketCap);
  const right = BigInt(b.marketCap);
  return right > left ? 1 : right < left ? -1 : 0;
}

function marketCapLabel(lamports: string, solUsd: number | null): string {
  const sol = Number(BigInt(lamports)) / 1e9;

  if (solUsd === null) {
    if (sol >= 1_000) return `${(sol / 1_000).toFixed(1)}K◎`;
    if (sol >= 1) return `${sol.toFixed(1)}◎`;
    return `${sol.toFixed(2)}◎`;
  }

  const usd = sol * solUsd;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  if (usd >= 1) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
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

function TokenImage({ token }: { token: Token }) {
  const [broken, setBroken] = useState(false);

  // Re-pointed at a gateway that answers browsers. ipfs.io, where most of these
  // live, returns 403 to one, which is why so many rows drew the mark instead.
  const src = imageSrc(token.image);
  if (!src || broken) return <MintMark mint={token.mint} />;

  return (
    // Not next/image: these are arbitrary hosts chosen by whoever launched the
    // token, and putting them through the optimiser would mean this server
    // fetching a stranger's URL on demand. Rendered by the browser, sandboxed
    // by the browser, and never sent a referrer.
    <img
      className="token-img"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

function Row({
  token,
  lane,
  fresh,
  now,
  solUsd,
}: {
  token: Token;
  lane: LaneKey;
  fresh: boolean;
  now: number;
  solUsd: number | null;
}) {
  const progress = token.progressBps;

  return (
    <li className={fresh ? 'feed-row fresh' : 'feed-row'}>
      <a href={`/t/${token.mint}`}>
        <TokenImage token={token} />

        <span className="feed-name">
          <strong>{token.symbol || '???'}</strong>
          <span className="dim">{token.name}</span>
          {/* Worth seeing without opening a filter panel. */}
          {(token.creatorLaunches ?? 1) >= 5 && (
            <span className="serial" title={`This creator has launched at least ${token.creatorLaunches} tokens`}>
              {token.creatorLaunches}x
            </span>
          )}
          {/*
            The phone's second line, which the terminal has no room for.

            A wide row can afford the ticker in bold with the name beside it and
            the age off in a column of its own. A phone row is one name and one
            number, so the name becomes the headline and everything supporting
            it goes underneath: ticker, then how old the thing is. Rendered
            here rather than assembled from the pieces above because the two
            layouts want the same facts in a different order, and CSS can hide
            a line but it cannot move one out of a grid cell.
          */}
          <span className="feed-sub">
            <span className="feed-sub-sym">{token.symbol || '???'}</span>
            <Sprout />
            <span className={freshAge(token.launchedAt, now) ? 'feed-sub-age new' : 'feed-sub-age'}>
              {age(token.launchedAt, now)}
            </span>
          </span>
        </span>

        {/* What a token is worth is the one figure worth having in every lane,
            so it sits in the same place in all three. A curve nobody has read
            yet shows the opening market cap every launch starts at rather than
            "n/a": that value is known, and it is what pump.fun shows too. */}
        <span className="feed-cap mono">
          {marketCapLabel(token.marketCap ?? OPENING_MARKET_CAP, solUsd)}
        </span>

        {/* And then whichever second figure the lane is actually about: how far
            along for the ones bonding, how old for the rest. */}
        {lane === 'bonding' && progress !== null ? (
          <span className="feed-progress">
            <span className="track" aria-hidden="true">
              <span className="fill" style={{ width: `${Math.min(100, progress / 100)}%` }} />
            </span>
            <span className="mono pct">{(progress / 100).toFixed(0)}%</span>
          </span>
        ) : (
          <span className="feed-age mono dim">{age(token.launchedAt, now)}</span>
        )}
      </a>
    </li>
  );
}

export function LaunchFeedList({ variant = 'preview' }: { variant?: 'preview' | 'terminal' }) {
  const terminal = variant === 'terminal';

  const [lanes, setLanes] = useState<Lanes | null>(null);
  /*
   * The lanes, readable synchronously.
   *
   * The two stream handlers used to do their work inside a `setLanes` updater
   * and call `setArrived` from within it. A state updater has to be pure:
   * React is free to run it more than once, and a `setState` inside one is a
   * render-phase update that can send React round again, re-running the updater
   * and scheduling another update, until it gives up with "Maximum update depth
   * exceeded" and the error boundary replaces the page. On a feed taking a
   * launch every few seconds that is a page that breaks while you sit and watch
   * it, which is exactly what was reported.
   *
   * With the current value in a ref, both handlers compute the next lanes and
   * the arrival set as plain values and then set each once.
   */
  const lanesRef = useRef<Lanes | null>(null);
  const commitLanes = useCallback((next: Lanes | null) => {
    lanesRef.current = next;
    setLanes(next);
  }, []);
  const [results, setResults] = useState<Token[] | null>(null);
  const [query, setQuery] = useState('');
  /** This connection is open. */
  const [live, setLive] = useState(false);
  /** Launches can actually arrive — the upstream feed is up. Null until told. */
  const [feedLive, setFeedLive] = useState<boolean | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [solUsd, setSolUsd] = useState<number | null>(null);
  const [laneFilters, setLaneFilters] = useState<LaneFilters>(DEFAULT_LANE_FILTERS);
  /*
   * Which lane a narrow screen is showing.
   *
   * Only read by the stylesheet, which hides the other two below the width all
   * three fit at. Held here rather than in a media query alone because the
   * choice has to survive a re-render and be reflected in the pills.
   */
  const [shownLane, setShownLane] = useState<LaneKey>('new');
  const [showFilters, setShowFilters] = useState(false);
  /*
   * Whether the phone is showing the search field.
   *
   * On a wide screen search is a field at the top of the feed and costs
   * nothing. On a phone the reference layout has no search bar at all: the
   * list starts at the top of the screen and search lives behind an icon. So
   * it does here, next to the lane buttons, and the field appears under them
   * only once it is asked for. Ignored entirely above the breakpoint, where
   * the field is always shown.
   */
  const [searchOpen, setSearchOpen] = useState(false);
  /** Which lane the open panel is editing. */
  const [filterTab, setFilterTab] = useState<LaneKey>('new');
  /** Pausing the arrival of new rows is a feed-wide choice, not a per-lane one. */
  const [paused, setPaused] = useState(false);

  const searching = query.trim().length > 0;

  /*
   * Read by the stream handlers, which are registered once and would otherwise
   * close over the values from the render that created them.
   *
   * Written in an effect rather than during render. A ref mutated in the render
   * body is a side effect in a function React is allowed to run twice, throw
   * away, or interrupt — so under concurrent rendering the handlers can end up
   * reading a value from a render that was never committed.
   */
  const searchingRef = useRef(searching);
  const pausedRef = useRef(paused);

  useEffect(() => {
    searchingRef.current = searching;
  }, [searching]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  /** False until the first save has been deliberately skipped. */
  const savedOnce = useRef(false);

  // Filters persist. A trader who set a floor does not want to set it again
  // every time they open the page.
  useEffect(() => {
    if (!terminal) return;
    try {
      const saved = localStorage.getItem(FILTER_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved) as { lanes?: Partial<Record<LaneKey, Partial<Filters>>> };
      // Only the new per-lane shape is read. Anything else is an older single
      // filter set, and merging its fields onto three lanes would be a guess;
      // dropping it just means the filters open empty once.
      if (parsed.lanes) {
        setLaneFilters({
          new: { ...DEFAULT_FILTERS, ...parsed.lanes.new },
          bonding: { ...DEFAULT_FILTERS, ...parsed.lanes.bonding },
          bonded: { ...DEFAULT_FILTERS, ...parsed.lanes.bonded },
        });
      }
    } catch {
      // A corrupt or unavailable store is not worth failing a page over.
    }
  }, [terminal]);

  useEffect(() => {
    if (!terminal) return;

    // Never on the first pass. Both effects run in the same commit, and this
    // one still sees the initial state rather than the restored one — so it
    // wrote the defaults straight back over the saved filters every time the
    // page opened, and nothing ever persisted. The restore lands on the next
    // render, and that is the one worth writing.
    if (!savedOnce.current) {
      savedOnce.current = true;
      return;
    }

    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ lanes: laneFilters }));
    } catch {
      // Private browsing, a full quota — neither is this page's problem.
    }
  }, [laneFilters, terminal]);

  /*
   * The filters, as the server needs them.
   *
   * Sent so the query can read past the sixty rows a lane returns and hand back
   * sixty that actually match. Filtering only in the browser meant a filter
   * narrowed whatever window that browser had accumulated, so two machines
   * open for different lengths of time gave different answers to the same
   * question and neither was showing everything.
   *
   * Serialised as a string rather than an object so it can be a dependency
   * without re-firing the fetch on every render.
   */
  const filterParam = useMemo(
    () => (terminal ? JSON.stringify(laneFilters) : ''),
    [terminal, laneFilters],
  );

  const load = useCallback(
    async (search: string, filters: string) => {
      try {
        const limit = terminal ? MAX_ROWS : 20;
        const filterQuery = filters && filters !== JSON.stringify(DEFAULT_LANE_FILTERS)
          ? `&filters=${encodeURIComponent(filters)}`
          : '';
        const url = search
          ? `/api/launches?q=${encodeURIComponent(search)}&limit=${limit}`
          : `/api/launches?limit=${limit}${filterQuery}`;
        const body = (await (await fetch(url)).json()) as {
          lanes?: Lanes;
          results?: Token[];
          solUsd?: number | null;
        };
        if (body.solUsd !== undefined) setSolUsd(body.solUsd);
        if (search) setResults(body.results ?? []);
        else {
          setResults(null);
          if (body.lanes) commitLanes(body.lanes);
        }
      } catch {
        if (search) setResults([]);
      }
    },
    [terminal],
  );

  // Debounced, so typing a mint address does not fire a query per keystroke,
  // and so dragging a market-cap field does not fire one per digit.
  useEffect(() => {
    const timer = setTimeout(() => void load(query.trim(), filterParam), query ? 250 : 300);
    return () => clearTimeout(timer);
    // filterParam belongs here: changing a filter has to go back to the server,
    // or the deep scan never happens and the filter is back to narrowing a
    // window, which is the bug this was written to fix.
  }, [query, filterParam, load]);

  // The exchange rate moves on its own clock, slower than anything else here.
  useEffect(() => {
    const read = (): void => {
      void fetch('/api/sol-price')
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { solUsd: number | null } | null) => {
          if (body) setSolUsd(body.solUsd);
        })
        .catch(() => undefined);
    };
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Ages are relative, so they have to be recomputed rather than rendered once.
  // One timer for every lane rather than one per row.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/launches/stream');

    source.addEventListener('ready', (event) => {
      setLive(true);
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as { feedLive?: boolean };
        if (typeof body.feedLive === 'boolean') setFeedLive(body.feedLive);
      } catch {
        // A malformed ready payload is not a reason to fail the connection.
      }
    });

    source.addEventListener('status', (event) => {
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as { feedLive?: boolean };
        if (typeof body.feedLive === 'boolean') setFeedLive(body.feedLive);
      } catch {
        // Same.
      }
    });

    source.addEventListener('launches', (event) => {
      // While somebody is searching, arrivals would shove their results
      // around. Paused is the same idea asked for explicitly: the stream stays
      // connected and the screen stops moving.
      if (searchingRef.current || pausedRef.current) return;

      const incoming = JSON.parse((event as MessageEvent<string>).data) as Token[];

      const current = lanesRef.current;
      if (!current) return;

      // Every lane, not just the new one: a replayed launch for a token that
      // has since bonded would otherwise appear in two columns at once.
      const seen = new Set(
        [...current.new, ...current.bonding, ...current.bonded].map((token) => token.mint),
      );

      // A reconnecting socket replays recent history, so repeats are normal.
      // Deduped within the batch as well as against it: one flush can carry the
      // same mint twice, and filtering only against what is already on screen
      // would let both copies through.
      const additions: Token[] = [];
      for (const token of incoming) {
        if (seen.has(token.mint)) continue;
        seen.add(token.mint);
        additions.push(token);
      }
      if (additions.length === 0) return;

      // Always the new lane. A token cannot launch already bonded.
      commitLanes({ ...current, new: [...additions, ...current.new].slice(0, MAX_ROWS) });
      setArrived((was) => {
        const next = new Set(was);
        for (const token of additions) next.add(token.mint);
        return next;
      });
    });

    source.addEventListener('curves', (event) => {
      if (searchingRef.current || pausedRef.current) return;
      const updates = JSON.parse((event as MessageEvent<string>).data) as {
        mint: string;
        progressBps: number;
        marketCap: string | null;
        complete: boolean;
      }[];
      if (updates.length === 0) return;

      const byMint = new Map(updates.map((update) => [update.mint, update]));

      const current = lanesRef.current;
      if (!current) return;

      {
        // Apply the new numbers wherever the token already is.
        const applied: Lanes = {
          new: current.new.map((token) => merge(token, byMint.get(token.mint))),
          bonding: current.bonding.map((token) => merge(token, byMint.get(token.mint))),
          bonded: current.bonded.map((token) => merge(token, byMint.get(token.mint))),
        };

        // Then move anything that has crossed a boundary. This is the whole
        // reason the lanes are worth having: a token graduating should appear
        // under Bonded while you are looking at it.
        const known = new Map<string, Token>();
        for (const lane of ['new', 'bonding', 'bonded'] as const) {
          for (const token of applied[lane]) known.set(token.mint, token);
        }

        const next: Lanes = { new: [], bonding: [], bonded: [] };
        const promoted = new Set<string>();

        for (const token of known.values()) {
          const progress = token.progressBps ?? 0;
          const belongs: LaneKey = token.complete ? 'bonded' : progress >= 5_000 ? 'bonding' : 'new';
          const wasIn = laneOf(current, token.mint);
          if (wasIn !== null && wasIn !== belongs) promoted.add(token.mint);
          next[belongs].push(token);
        }

        /*
         * Order within each lane is the lane's own: newest, closest, biggest.
         *
         * Graduated had no sort at all and sat in whatever order the stream
         * happened to deliver, so the lane that is entirely about which tokens
         * made it was the one lane with no ranking in it. Sorted by what they
         * are worth, largest first.
         */
        next.new.sort((a, b) => b.launchedAt - a.launchedAt);
        // Soon and Graduated both rank by what a token is worth, largest first.
        // Soon used to rank by curve progress, which is a different question and
        // reads as unsorted next to a column of market caps.
        next.bonding.sort(byMarketCap);
        next.bonded.sort(byMarketCap);

        commitLanes({
          new: next.new.slice(0, MAX_ROWS),
          bonding: next.bonding.slice(0, MAX_ROWS),
          bonded: next.bonded.slice(0, MAX_ROWS),
        });

        if (promoted.size > 0) {
          setArrived((was) => new Set([...was, ...promoted]));
        }
      }
    });

    source.onerror = () => setLive(false);

    return () => source.close();
  }, []);

  // The highlight on a row that arrived or moved is a moment, not a state.
  useEffect(() => {
    if (arrived.size === 0) return;
    const timer = setTimeout(() => setArrived(new Set()), 2_000);
    return () => clearTimeout(timer);
  }, [arrived]);

  // The set of mints still missing a picture, as a stable string. Keyed on the
  // missing set itself rather than the whole `lanes` object so an unrelated
  // price tick, which arrives faster than the retry delay on a busy feed, does
  // not keep resetting the timer below and leave those rows blank forever.
  const missingImageKey = useMemo(() => {
    if (!lanes) return '';
    const missing = [...lanes.new, ...lanes.bonding, ...lanes.bonded]
      .filter((token) => !token.image)
      .map((token) => token.mint);
    return [...new Set(missing)].sort().join(',');
  }, [lanes]);

  // Pictures resolve after the token exists, so rows that arrived over the
  // stream without one ask again a moment later rather than staying blank
  // until a reload.
  useEffect(() => {
    if (!missingImageKey) return;
    const mints = missingImageKey.split(',').slice(0, 60).join(',');

    const timer = setTimeout(() => {
      void fetch(`/api/token-images?mints=${mints}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { images: Record<string, string> } | null) => {
          if (!body || Object.keys(body.images).length === 0) return;
          const paint = (token: Token): Token =>
            token.image ? token : { ...token, image: body.images[token.mint] ?? null };
          // Through the ref as well, or the next stream event computes from a
          // copy of the lanes that never got its pictures and paints them out
          // again on the very next launch.
          const current = lanesRef.current;
          if (!current) return;
          commitLanes({
            new: current.new.map(paint),
            bonding: current.bonding.map(paint),
            bonded: current.bonded.map(paint),
          });
        })
        .catch(() => undefined);
    }, 3_000);

    return () => clearTimeout(timer);
  }, [missingImageKey]);

  /** Filters are the terminal's; the preview shows what the server sent. */
  const visible = useCallback(
    (lane: LaneKey): Token[] => {
      const rows = lanes?.[lane] ?? [];
      if (!terminal) return rows.slice(0, PREVIEW_ROWS);

      // Each lane is filtered by its own set. The rule itself lives in
      // lib/feed-filters, so it can be tested without a browser.
      const filters = laneFilters[lane];
      const nowSeconds = Math.floor(now / 1000);
      return rows.filter((token) => matchesFilters(token, filters, { solUsd, nowSeconds }));
    },
    [lanes, terminal, laneFilters, solUsd, now],
  );

  // The lane the panel is editing, and a setter that touches only that lane.
  const tabFilters = laneFilters[filterTab];
  const laneTitle = LANES.find((laneDef) => laneDef.key === filterTab)?.title ?? 'new';
  const updateTab = useCallback(
    (patch: (was: Filters) => Filters) => {
      setLaneFilters((prev) => ({ ...prev, [filterTab]: patch(prev[filterTab]) }));
    },
    [filterTab],
  );
  const totalActiveFilters = LANES.reduce(
    (sum, laneDef) => sum + activeFilterCount(laneFilters[laneDef.key]),
    0,
  );

  return (
    <section id="feed" aria-label="Tokens" className="term feed-term">
      <div className="term-bar">
        <span className="prompt">~/feed</span>
        <span>pump.fun</span>
        {/* Three states, because there are three. Connected and hearing
            launches is streaming; connected to a server that is hearing
            nothing is stalled, which used to read as streaming while the
            banner above said the opposite. */}
        <span className={live && feedLive !== false && !paused ? 'pill live' : 'pill'}>
          {paused
            ? 'paused'
            : !live
              ? 'reconnecting'
              : feedLive === false
                ? 'stalled'
                : 'streaming'}
        </span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="term-body">
        <div className={searchOpen ? 'feed-controls search-open' : 'feed-controls'}>
          <label className="field feed-search">
            <span>Search</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Name, symbol, or paste a mint address"
            />
          </label>

          {terminal && (
            <>
              <button
                type="button"
                className={showFilters || totalActiveFilters > 0 ? 'preset on' : 'preset'}
                onClick={() => setShowFilters((was) => !was)}
                aria-expanded={showFilters}
              >
                Filters
                {totalActiveFilters > 0 && (
                  <span className="filter-badge">{totalActiveFilters}</span>
                )}
              </button>
              <button
                type="button"
                className={paused ? 'preset on' : 'preset'}
                onClick={() => setPaused((was) => !was)}
                aria-pressed={paused}
              >
                {paused ? 'Paused' : 'Pause'}
              </button>
            </>
          )}
        </div>

        {terminal && showFilters && (
          <div className="feed-filters">
            {/* One tab per lane, because each lane is filtered on its own. The
                count on a tab is how many filters that lane has set, so a lane
                quietly filtering is visible without opening it. */}
            <div className="filter-tabs" role="tablist">
              {LANES.map((laneDef) => {
                const count = activeFilterCount(laneFilters[laneDef.key]);
                return (
                  <button
                    key={laneDef.key}
                    type="button"
                    role="tab"
                    aria-selected={filterTab === laneDef.key}
                    className={filterTab === laneDef.key ? 'filter-tab on' : 'filter-tab'}
                    onClick={() => setFilterTab(laneDef.key)}
                  >
                    {laneDef.title}
                    {count > 0 && <span className="filter-badge">{count}</span>}
                  </button>
                );
              })}
            </div>

            <div className="filter-head">
              <span className="dim">Filtering the {laneTitle} lane.</span>
              <button
                type="button"
                className="linklike"
                onClick={() => updateTab(() => ({ ...DEFAULT_FILTERS }))}
                disabled={activeFilterCount(tabFilters) === 0}
              >
                Reset this lane
              </button>
            </div>

            <div className="filter-grid">
              <label className="field">
                <span>Search names</span>
                <input
                  type="text"
                  placeholder="cat, dog, pepe"
                  value={tabFilters.include}
                  onChange={(event) => updateTab((was) => ({ ...was, include: event.target.value }))}
                />
              </label>

              <label className="field">
                <span>Hide names</span>
                <input
                  type="text"
                  placeholder="test, scam"
                  value={tabFilters.exclude}
                  onChange={(event) => updateTab((was) => ({ ...was, exclude: event.target.value }))}
                />
              </label>
            </div>

            <RangeRow
              label="Market cap ($)"
              min={tabFilters.minMarketCapUsd}
              max={tabFilters.maxMarketCapUsd}
              onMin={(v) => updateTab((was) => ({ ...was, minMarketCapUsd: v }))}
              onMax={(v) => updateTab((was) => ({ ...was, maxMarketCapUsd: v }))}
            />
            <RangeRow
              label="Curve progress (%)"
              min={tabFilters.minProgressPct}
              max={tabFilters.maxProgressPct}
              onMin={(v) => updateTab((was) => ({ ...was, minProgressPct: v }))}
              onMax={(v) => updateTab((was) => ({ ...was, maxProgressPct: v }))}
            />
            <RangeRow
              label="Age (minutes)"
              min={tabFilters.minAgeMin}
              max={tabFilters.maxAgeMin}
              onMin={(v) => updateTab((was) => ({ ...was, minAgeMin: v }))}
              onMax={(v) => updateTab((was) => ({ ...was, maxAgeMin: v }))}
            />

            <label className="field">
              <span>Creator&apos;s launches, at most</span>
              <select
                value={tabFilters.maxCreatorLaunches}
                onChange={(event) =>
                  updateTab((was) => ({ ...was, maxCreatorLaunches: Number(event.target.value) }))
                }
              >
                <option value={0}>Any</option>
                <option value={1}>First launch only</option>
                <option value={3}>3 or fewer</option>
                <option value={10}>10 or fewer</option>
              </select>
            </label>

            <label className="field checkbox">
              <input
                type="checkbox"
                checked={tabFilters.hideImageless}
                onChange={(event) =>
                  updateTab((was) => ({ ...was, hideImageless: event.target.checked }))
                }
              />
              <span>Hide tokens with no image</span>
            </label>

            <p className="dim filter-note">
              Only what this feed can actually measure. It indexes pump.fun launches and reads
              their curves, so it knows market cap, curve progress, age and a floor on a
              creator&apos;s launches. It does not track holders, snipers or insider wallets, so
              there are no filters here pretending to.
            </p>

            {solUsd === null &&
              (tabFilters.minMarketCapUsd > 0 || tabFilters.maxMarketCapUsd > 0) && (
                <p className="dim" style={{ fontSize: 12 }}>
                  No exchange rate right now, so the market cap filter is paused until one returns.
                </p>
              )}
          </div>
        )}

        {searching ? (
          results === null ? (
            <p className="dim">Searching…</p>
          ) : results.length === 0 ? (
            <p className="dim">Nothing matches that.</p>
          ) : (
            <ul className="bare feed">
              {results.map((token) => (
                <Row
                  key={token.mint}
                  token={token}
                  lane="new"
                  fresh={false}
                  now={now}
                  solUsd={solUsd}
                />
              ))}
            </ul>
          )
        ) : (
          <>
          {/*
            One lane at a time, on a phone.
            
            Three columns side by side is the whole point of this on a desktop
            and unusable on a screen a thumb wide: each column ends up about a
            hundred pixels across, which is not enough for a name and a market
            cap. The lanes become a choice instead, and the chosen one gets the
            full width. Hidden entirely where there is room for all three.
          */}
          <div className="lane-picker">
            <div className="lane-pills" role="tablist" aria-label="Feed">
              {LANES.map((lane) => (
                <button
                  key={lane.key}
                  type="button"
                  role="tab"
                  aria-selected={shownLane === lane.key}
                  className={shownLane === lane.key ? 'lane-pill on' : 'lane-pill'}
                  onClick={() => setShownLane(lane.key)}
                >
                  {lane.short}
                </button>
              ))}
            </div>

            {/* The phone's controls, in the space the reference gives to one
                button on the right of the same row. Search opens the field
                under the buttons; filters open the same panel the terminal
                uses, since a market cap floor is worth having on a phone even
                if setting one is fiddly. */}
            <div className="lane-tools">
              <button
                type="button"
                className={searchOpen ? 'lane-tool on' : 'lane-tool'}
                aria-expanded={searchOpen}
                aria-label="Search tokens"
                onClick={() => setSearchOpen((was) => !was)}
              >
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.6-3.6" />
                </svg>
              </button>
              {terminal && (
                <button
                  type="button"
                  className={showFilters || totalActiveFilters > 0 ? 'lane-tool on' : 'lane-tool'}
                  aria-expanded={showFilters}
                  aria-label="Filters"
                  onClick={() => setShowFilters((was) => !was)}
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 6h16M7 12h10M10 18h4" />
                  </svg>
                  {totalActiveFilters > 0 && <span className="tool-dot" aria-hidden="true" />}
                </button>
              )}
            </div>
          </div>

          <div
            className={terminal ? 'lanes tall' : 'lanes'}
            data-shown={shownLane}
          >
            {LANES.map((lane) => {
              const rows = visible(lane.key);
              return (
                <div className="lane" data-lane={lane.key} key={lane.key}>
                  <div className="lane-head">
                    <span className="prompt">{lane.prompt}</span>
                    {/* h2: these sit directly under the page heading, and as
                        h3 they skipped a level with nothing in between. */}
                    <h2>{lane.title}</h2>
                    <span className="lane-blurb">
                      {terminal && lanes ? `${rows.length} shown` : lane.blurb}
                    </span>
                  </div>

                  {/* A column of bare numbers has to say what it is. */}
                  <div className="lane-cols" aria-hidden="true">
                    <span>Token</span>
                    <span>MCap</span>
                    <span>{lane.key === 'bonding' ? 'Bonded' : 'Age'}</span>
                  </div>

                  {!lanes ? (
                    <p className="dim lane-empty">Loading…</p>
                  ) : rows.length === 0 ? (
                    <p className="dim lane-empty">
                      {lane.key === 'new'
                        ? 'Nothing yet. This fills as tokens are created.'
                        : lane.key === 'bonding'
                          ? 'Nothing past that threshold right now.'
                          : 'Nothing has graduated yet.'}
                    </p>
                  ) : (
                    <ul className="bare feed">
                      {rows.map((token) => (
                        <Row
                          key={token.mint}
                          token={token}
                          lane={lane.key}
                          fresh={arrived.has(token.mint)}
                          now={now}
                          solUsd={solUsd}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
          </>
        )}

        {!terminal && (
          <a href="/feed" className="button-link feed-open">
            Open the terminal
          </a>
        )}
      </div>
    </section>
  );
}

function merge(
  token: Token,
  update: { progressBps: number; marketCap: string | null; complete: boolean } | undefined,
): Token {
  if (!update) return token;
  return {
    ...token,
    progressBps: update.progressBps,
    // Kept rather than overwritten with nothing. A graduated curve stops
    // reporting a price, and blanking the column at the moment a token
    // succeeds is the worst time to lose the number.
    marketCap: update.marketCap ?? token.marketCap,
    complete: update.complete,
  };
}

function laneOf(lanes: Lanes, mint: string): LaneKey | null {
  if (lanes.new.some((token) => token.mint === mint)) return 'new';
  if (lanes.bonding.some((token) => token.mint === mint)) return 'bonding';
  if (lanes.bonded.some((token) => token.mint === mint)) return 'bonded';
  return null;
}
