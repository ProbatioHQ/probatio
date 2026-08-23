'use client';

import { useEffect, useRef, useState } from 'react';
import { imageSrc } from '@/lib/image-src';
import type { Phase } from '@/lib/roadmap';
import type { StreamBoard } from '@/lib/livestream';

/**
 * The board as it arrives, which carries one field the board itself does not.
 *
 * `now` is stamped by the route when the response is written; `at` is when the
 * figures behind it were read. They differ by up to the cache's twelve seconds,
 * and conflating them is what made the wall clock lag and stutter.
 */
type Payload = StreamBoard & { readonly now?: number; readonly build?: string };

/**
 * The board a camera points at, twenty four hours a day.
 *
 * Two constraints shape all of it. It is watched in ten second glances by
 * somebody deciding whether this is a real thing, so every frame has to answer
 * what this is and whether it is alive without being read start to finish. And
 * it runs for months unattended, so nothing may accumulate: no growing arrays,
 * no listeners added per tick, no state that is only correct on the first pass.
 *
 * The frame is fixed at 1920 by 1080 and scaled to whatever it is captured
 * into. A broadcast that reflows when the window is a different shape is a
 * broadcast whose layout was never actually approved, and this way what was
 * checked once is what goes out.
 */

const POLL_MS = 12_000;
const CARD_MS = 20_000;

/**
 * How long the old card takes to leave before the new one arrives.
 *
 * The rotation used to be a cut: one card replaced by another between frames,
 * which on a stream reads as a glitch rather than a transition. Four hundred
 * milliseconds out and the same in, so the two never overlap and nothing has to
 * be rendered twice.
 */
const SWAP_MS = 400;

const CARDS = ['what', 'runners', 'tape', 'season', 'engine', 'autonomy', 'roadmap'] as const;
type Card = (typeof CARDS)[number];

const CARD_TITLE: Record<Card, string> = {
  what: 'What this is',
  runners: 'Runners',
  tape: 'The tape',
  season: 'Season',
  engine: 'The engine, against reality',
  autonomy: 'It checks itself',
  roadmap: 'What is next',
};

/*
 * What a card says before anything has been read.
 *
 * Every empty state here is a claim about the world: no fills recorded, no
 * season open, no board right now. All three are false while the first read is
 * still in flight, and on a broadcast a false statement said calmly is worse
 * than an obviously blank panel.
 */
const WAITING = 'Waiting for the first read.';

const SOL = 1_000_000_000;

function sol(lamports: string): string {
  const v = Number(lamports) / SOL;
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function pct(bps: number | null): string {
  if (bps === null) return '-';
  return `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`;
}

function cap(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${Math.round(usd / 1e3)}K`;
  return `$${Math.round(usd)}`;
}

function ago(seconds: number, now: number): string {
  const d = Math.max(0, now - seconds);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

/**
 * The wall clock, in the timezone of whatever is showing this.
 *
 * It printed UTC, which is correct everywhere and matches nobody's clock. The
 * screen is captured on a machine in a room, and the person in that room reads
 * it against the clock on their wall: to them a correct UTC reading is simply
 * an hour or two wrong, and there is no way to tell that from a broken clock.
 *
 * The instant is still the server's, corrected for whatever the local machine
 * thinks the time is. Only the timezone it is rendered in is local, so a
 * capture machine with a wrong clock still shows the right moment.
 */
function hhmmss(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The zone that clock is in, named, so it is never ambiguous on a recording.
 *
 * Read once. It cannot change while a broadcast is running, and asking the
 * formatter every second for an answer that is fixed is work for nothing.
 */
const ZONE = (() => {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(
      new Date(),
    );
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
})();

function countdown(endsAt: number, now: number): string {
  const d = Math.max(0, endsAt - now);
  const days = Math.floor(d / 86_400);
  const hours = Math.floor((d % 86_400) / 3600);
  const mins = Math.floor((d % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * The shape a token made getting where it is.
 *
 * A percentage is the number every other site shows and says nothing about the
 * path: up forty percent in a straight line and up forty percent after a round
 * trip through minus sixty are the same figure and not the same token. Drawn as
 * an SVG path rather than a canvas because there are eight of these on screen
 * being replaced every twelve seconds, and eight canvases means eight contexts
 * to allocate and redraw for a line with forty points in it.
 */
function Spark({ points, up, flat }: { points: readonly number[]; up: boolean; flat?: boolean }) {
  if (points.length < 2) return <span className="sb-spark" />;

  const low = Math.min(...points);
  const high = Math.max(...points);
  // A flat line still has to be a line, and dividing by its range is division
  // by zero: a token that has not moved renders down the middle.
  const span = high - low || 1;
  const W = 100;
  const H = 28;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((v - low) / span) * (H - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');

  // Drift is not a direction. A gap is a gap whichever way the engine leaned,
  // so that line is drawn in one colour and read against zero.
  const tone = flat ? 'flat' : up ? 'up' : 'dn';
  return (
    <svg className="sb-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L${W} ${H} L0 ${H} Z`} className={`fill ${tone}`} />
      <path d={d} className={`line ${tone}`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** What a season is, for the long stretches when the board has nobody on it. */
function SeasonPrimer() {
  return (
    <div className="sb-season-what">
      <div>
        <span className="k">A season</span>
        <span className="v">One window, one starting balance, everybody on the same clock and
          the same fills.</span>
      </div>
      <div>
        <span className="k">The record</span>
        <span className="v">Every fill sealed as it lands, so a placing is something anybody can
          recompute.</span>
      </div>
      <div>
        <span className="k">Meanwhile</span>
        <span className="v">Free play is always open, on the same engine, with nothing to enter
          and nothing at stake.</span>
      </div>
    </div>
  );
}

/** A picture that may not load, which on a stream must never be a broken icon. */
function Art({ src, alt }: { src: string | null; alt: string }) {
  const [broken, setBroken] = useState(false);
  const resolved = imageSrc(src);
  if (!resolved || broken) return <span className="sb-art sb-art-none" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolved}
      alt={alt}
      className="sb-art"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

export function StreamBoardView({ phase }: { phase: Phase | null }) {
  const [board, setBoard] = useState<StreamBoard | null>(null);
  const [card, setCard] = useState(0);
  const [leaving, setLeaving] = useState(false);
  /**
   * Server seconds minus local seconds, so the clock is right when drawn.
   *
   * A ref and not state, because nothing renders it: the tick reads it to
   * compute the clock and that is all it is for. It was both, mirrored into the
   * ref during render, which React refuses for good reason. Under concurrent
   * rendering a render can be thrown away and run again, so a ref written there
   * records something that never happened.
   */
  const skewRef = useRef<number | null>(null);
  /** The build this page was served by, so a newer one can be noticed. */
  const builtRef = useRef<string | null>(null);
  const [clock, setClock] = useState(0);
  const [scale, setScale] = useState(1);

  /*
   * The clock, ticking locally.
   *
   * Everything that says "ago" needs a now, and taking it from the payload
   * would freeze every relative time between polls: a tape would sit at "4s
   * ago" for twelve seconds and then jump. Seeded from the server's own clock
   * on the first payload so the two cannot disagree about what time it is.
   */
  useEffect(() => {
    const tick = () => setClock(Math.floor(Date.now() / 1000) + (skewRef.current ?? 0));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;

    async function pull(): Promise<void> {
      try {
        const response = await fetch('/api/livestream', { cache: 'no-store' });
        if (!response.ok) throw new Error(String(response.status));
        const next = (await response.json()) as Payload;
        if (!alive) return;
        setBoard(next);
        /*
         * Anchored to the server's clock rather than counted from it.
         *
         * Storing the difference and adding it to the local clock means the
         * time shown is right whenever it is drawn, even if the browser
         * throttled the interval while the tab was in the background. Counting
         * ticks instead loses a second for every tick that did not fire and
         * never gets it back until the next poll.
         */
        skewRef.current = (next.now ?? next.at) - Math.floor(Date.now() / 1000);

        /*
         * A deploy reaches the broadcast on its own.
         *
         * The container that streams this loaded the page once and holds it
         * open for weeks. Every number on it refreshes, because those come from
         * the polling; the page itself does not, so a correction to the words
         * on the board would go out to nobody until somebody restarted the
         * stream, and restarting the stream drops it off pump.fun.
         *
         * So the build the server is running travels with the payload, and a
         * change to it means this page is out of date with the site it came
         * from. Reloading costs a flicker. Broadcasting a sentence that was
         * corrected a week ago costs more.
         */
        if (next.build) {
          if (builtRef.current === null) builtRef.current = next.build;
          else if (builtRef.current !== next.build) window.location.reload();
        }
      } catch {
        /*
         * A failed poll keeps the last board rather than clearing it.
         *
         * This runs unattended for months and a blank screen is the worst
         * possible response to a thirty second outage: the numbers on screen
         * were true when they were read, and a stale board with a stale clock
         * says so honestly. The header shows how old it is, and past a minute
         * it stops claiming to be live.
         */
      }
    }

    void pull();
    const id = setInterval(() => void pull(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /*
   * Rotation, unless a card was asked for by name.
   *
   * `?card=autonomy` holds that one and stops the cycle. Added because a board
   * that only ever rotates cannot be pointed at anything: there is no way to
   * check one card without waiting out the other six, and no way to hold one
   * up during a stream while talking about it.
   *
   * Modulo on a small integer, so nothing accumulates over a run of months.
   */
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('card');
    const pinned = CARDS.indexOf(asked as Card);
    if (pinned >= 0) {
      setCard(pinned);
      return;
    }
    /*
     * Fade the card out, swap it, fade it in.
     *
     * The swap happens while nothing is on screen, so the two cards never
     * overlap and the incoming one is never seen mid-layout. The inner timer is
     * tracked so unmounting between the two halves cannot leave a swap pending
     * against a component that has gone.
     */
    let swap: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      setLeaving(true);
      swap = setTimeout(() => {
        setCard((c) => (c + 1) % CARDS.length);
        setLeaving(false);
      }, SWAP_MS);
    }, CARD_MS);

    return () => {
      clearInterval(id);
      if (swap) clearTimeout(swap);
    };
  }, []);

  /*
   * The fixed frame, fitted to the window.
   *
   * Capture software gives whatever canvas it was configured with, and a
   * layout designed at one size and reflowed into another is a layout nobody
   * approved. Scaling one fixed frame means the composition that was checked
   * is the composition that goes out, at any capture size.
   */
  useEffect(() => {
    const fit = () =>
      setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const which = CARDS[card] ?? 'what';
  /*
   * A board that has not been read yet is not a board.
   *
   * The cold start hands one back so a request does not hang, and every figure
   * on it is zero. Treating it as real prints "0 traders, 0 fills" under a
   * green light, which is worse than printing nothing: nobody watching can tell
   * a quiet site from one that has not answered yet.
   */
  const known = board?.ready ? board : null;
  const stale = known ? clock - known.at : 0;

  return (
    <div id="livestream" className="sb-root">
      <div className="sb-frame" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <header className="sb-head">
          <span className="sb-mark" aria-hidden="true" />
          <span className="sb-word">PROBATIO</span>
          <span className="sb-tag">Paper money, real prices, a record you can check</span>
          <span className="sb-right">
            {/* Ticking every second, so a still frame of this can be told from
                a frozen stream at a glance. */}
            <span className="sb-clock">
              {clock ? `${hhmmss(clock)}${ZONE ? ` ${ZONE}` : ''}` : '--:--:--'}
            </span>
            {/* Amber past a minute: the board is still true, just older than it
                looks, and saying so beats a confident stale number. */}
            <span className={`sb-dot${stale > 60 ? ' late' : ''}`} aria-hidden="true" />
            <span className="sb-live">
              {known ? (stale > 60 ? ago(known.at, clock) : 'LIVE') : 'CONNECTING'}
            </span>
          </span>
        </header>

        <div className="sb-vitals">
          <div><dt>Traders</dt><dd>{known?.vitals.traders ?? '-'}</dd></div>
          <div><dt>Accounts</dt><dd>{known?.vitals.accounts ?? '-'}</dd></div>
          <div><dt>Fills</dt><dd>{known?.vitals.fills ?? '-'}</dd></div>
          <div><dt>Last 24h</dt><dd>{known?.vitals.fillsToday ?? '-'}</dd></div>
          <div><dt>Engine</dt><dd>v{known?.vitals.engineVersion ?? '-'}</dd></div>
          <div><dt>Suspended</dt><dd>{known?.drift.suspended ?? '-'}</dd></div>
        </div>

        <main className={`sb-card${leaving ? ' leaving' : ''}`}>
          <div className="sb-card-head">
            <span className="sb-card-title">
              {CARD_TITLE[which]}
              <span className="sb-caret" aria-hidden="true" />
            </span>
            <span className="sb-card-dots" aria-hidden="true">
              {CARDS.map((c, i) => (
                <span key={c} className={i === card ? 'on' : ''} />
              ))}
            </span>
          </div>

          {which === 'what' && (
            <div className="sb-what">
              <h1>
                Trade the whole of pump.fun<br />with <em>nothing at risk</em>.
              </h1>
              <div className="sb-what-cols">
                <div>
                  <span className="k">Real prices</span>
                  <span className="v">Every launch as it happens, priced against the pool it
                    actually trades against.</span>
                </div>
                <div>
                  <span className="k">Honest fills</span>
                  <span className="v">Quoted from the reserves, with your impact, the fee, and a
                    real delay before it lands.</span>
                </div>
                <div>
                  <span className="k">A record that holds</span>
                  <span className="v">Every fill sealed. Anyone can rehash the lot themselves,
                    with our code, including against us.</span>
                </div>
              </div>
            </div>
          )}

          {which === 'runners' && (
            <div className="sb-runners">
              {(known?.movers ?? []).map((m) => (
                <div className="sb-run" key={m.mint}>
                  <Art src={m.image} alt="" />
                  <span className="sb-run-name">{m.symbol || m.name}</span>
                  <span className="sb-run-cap">{cap(m.marketCapUsd)}</span>
                  <Spark points={m.spark} up={(m.changeH1 ?? 0) >= 0} />
                  <span className={`sb-run-ch ${(m.changeH1 ?? 0) >= 0 ? 'up' : 'dn'}`}>
                    {m.changeH1 === null ? '-' : `${m.changeH1 >= 0 ? '+' : ''}${m.changeH1.toFixed(1)}%`}
                  </span>
                </div>
              ))}
              {(known?.movers.length ?? 0) === 0 && (
                <p className="sb-empty">{known ? 'No board right now.' : WAITING}</p>
              )}
            </div>
          )}

          {which === 'tape' && (
            <div className="sb-tape">
              <div className="sb-tape-head">
                <span>Trader</span><span>Token</span><span>Side</span>
                <span>Size</span><span>Impact</span><span>Latency</span><span>Seal</span>
              </div>
              {(known?.tape ?? []).slice(0, 9).map((t) => (
                <div className="sb-tape-row" key={`${t.seal}-${t.at}`}>
                  <span className="mono">{t.trader}</span>
                  <span className="mono dim">{t.mint.slice(0, 4)}…{t.mint.slice(-4)}</span>
                  <span className={t.side === 'buy' ? 'up' : 'dn'}>{t.side}</span>
                  <span className="mono">{sol(t.sol)} SOL</span>
                  <span className="mono dim">{(t.impactBps / 100).toFixed(2)}%</span>
                  <span className="mono dim">{t.latencyMs}ms</span>
                  <span className="mono seal">{t.seal}</span>
                </div>
              ))}
              {(known?.tape.length ?? 0) === 0 && (
                <p className="sb-empty">{known ? 'No fills recorded yet.' : WAITING}</p>
              )}
            </div>
          )}

          {which === 'season' && (
            <div className="sb-season">
              {known?.season ? (
                <>
                  <div className="sb-season-head">
                    <span className="sb-season-name">{known.season.name}</span>
                    {/* What the season is, said rather than implied by a
                        countdown that would be wrong two ways out of three. */}
                    <span className="sb-season-meta">
                      {known.season.state === 'running' &&
                        `${known.season.entrants} entered${
                          known.season.endsAt
                            ? ` · ${countdown(known.season.endsAt, clock)} left`
                            : ''
                        }`}
                      {known.season.state === 'upcoming' &&
                        (known.season.startsAt
                          ? `opens in ${countdown(known.season.startsAt, clock)}`
                          : 'opens soon')}
                      {known.season.state === 'ended' &&
                        `finished · ${known.season.entrants} entered`}
                    </span>
                  </div>
                  {/*
                    The standings as one block, rather than as the card's only
                    other child.

                    Spread across the card, two entrants ended up at opposite
                    ends of the screen with a field of black between them, which
                    reads as a rendering fault rather than as a short season.
                    Wrapped, the rows stay a list and the list is centred in
                    whatever the card has left, so it looks composed at two
                    names and at five.
                  */}
                  {known.season.top.length > 0 && (
                    <div className="sb-ranks">
                      {known.season.top.map((s) => (
                        <div className="sb-rank" key={s.rank}>
                          <span className="sb-rank-n">{s.rank}</span>
                          <span className="mono">{s.trader}</span>
                          <span className={`sb-rank-r ${s.returnBps >= 0 ? 'up' : 'dn'}`}>
                            {pct(s.returnBps)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/*
                    A season with nobody on the board is the same empty card as
                    no season at all, and it will look like that for the whole
                    of every entry window. It gets the same explainer, under the
                    line that says which of the two it is.
                  */}
                  {known.season.top.length === 0 && (
                    <div className="sb-season-none">
                      <span className="sb-season-none-head">
                        {known.season.state === 'running'
                          ? 'Open, and nobody has traded yet.'
                          : known.season.state === 'upcoming'
                            ? 'Not open yet.'
                            : 'Finished with nobody ranked.'}
                      </span>
                      <SeasonPrimer />
                    </div>
                  )}
                </>
              ) : (
                /*
                 * Between seasons, which is a state this card will be in for
                 * days at a time. One grey line in an empty field said nothing
                 * about what a season is or why anybody should wait for one, so
                 * it says that instead.
                 */
                <div className="sb-season-none">
                  <span className="sb-season-none-head">
                    {known ? 'No ranked season is running.' : WAITING}
                  </span>
                  {known && <SeasonPrimer />}
                </div>
              )}
            </div>
          )}

          {which === 'engine' && (
            <div className="sb-engine">
              <p className="sb-engine-lede">
                The simulator is measured against real fills on a timer. When it drifts far
                enough to be farmable, the token comes off the board on its own.
              </p>
              {/* The watchdog's own record, which it has been keeping all along
                  and this card was not showing. Flat is the good shape. */}
              <div className="sb-engine-chart">
                {(known?.drift.series.length ?? 0) > 1 ? (
                  <Spark points={known!.drift.series} up flat />
                ) : (
                  <span className="sb-engine-nochart">
                    {known ? 'The watchdog has not run yet.' : WAITING}
                  </span>
                )}
              </div>
              <div className="sb-engine-figs">
                <div>
                  <dt>Observations</dt>
                  <dd>{known?.drift.checked ?? '-'}</dd>
                </div>
                <div>
                  <dt>Worst gap</dt>
                  <dd>{known?.drift.worstBps === null || known?.drift.worstBps === undefined
                    ? '-' : `${(known.drift.worstBps / 100).toFixed(2)}%`}</dd>
                </div>
                <div>
                  <dt>Suspended</dt>
                  <dd>{known?.drift.suspended ?? '-'}</dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{known?.drift.at ? ago(known.drift.at, clock) : 'not yet'}</dd>
                </div>
              </div>
            </div>
          )}

          {which === 'autonomy' && (
            <div className="sb-auto">
              {known?.autonomy.latest ? (
                <>
                  <div className="sb-auto-head">
                    <span>
                      {known.autonomy.latest.checks} checks ·{' '}
                      {known.autonomy.latest.inspected} inspected ·{' '}
                      <b className={known.autonomy.latest.errors ? 'dn' : 'up'}>
                        {known.autonomy.latest.errors} errors
                      </b>{' '}
                      · {known.autonomy.latest.warnings} warnings
                    </span>
                    <span className="dim">{ago(known.autonomy.latest.at, clock)}</span>
                  </div>
                  <div className="sb-auto-checks">
                    {known.autonomy.latest.results.map((c) => (
                      <div className="sb-auto-check" key={c.id}>
                        <span className={`sb-auto-mk${c.findings.length ? ' warn' : ''}`} aria-hidden="true" />
                        <span className="sb-auto-title">{c.title}</span>
                        <span className="dim mono">{c.inspected} inspected</span>
                        <span className={c.findings.length ? 'sb-auto-n warn' : 'sb-auto-n'}>
                          {c.findings.length}
                        </span>
                      </div>
                    ))}
                  </div>
                  {/*
                    What it does, rather than what was argued for.
                    
                    This said only what a compiler can verify is ever fixed
                    automatically, which describes a design and not this
                    program. Nothing here fixes anything. It was on air saying
                    otherwise, on a board whose entire claim is that its numbers
                    can be checked, which is the one place a comfortable
                    overstatement costs the most.
                  */}
                  <p className="sb-auto-foot">
                    Findings are recorded, never repaired. Results are committed to the
                    repository rather than a database, so the history belongs to git and nobody
                    can make a failing check look like it never failed. What to do about a
                    finding is a decision, and a job that edits the fill engine at four in the
                    morning because a check told it to is not one anybody should want.
                  </p>
                </>
              ) : (
                <p className="sb-empty">{known ? 'No pass recorded yet.' : WAITING}</p>
              )}
            </div>
          )}

          {which === 'roadmap' && phase && (
            <div className="sb-road">
              <div className="sb-road-head">
                <span className="sb-road-tag">{phase.tag}</span>
                <span className="sb-road-name">{phase.name}</span>
              </div>
              {phase.items.map((item) => (
                <div className="sb-road-item" key={item.title}>
                  <span className="sb-road-title">{item.title}</span>
                  <span className="sb-road-detail">{item.detail}</span>
                </div>
              ))}
            </div>
          )}
        </main>

        {/*
          The tape, crawling, under whatever card is up.
          
          The board rotates every twenty seconds and until now nothing on it
          moved in between, so a viewer arriving mid-card could not tell a live
          page from a screenshot of one. This is the one element that is always
          in motion and always real: every fill as it landed, with the hash it
          was sealed with, repeated twice so the loop has no seam.
        */}
        <div className="sb-crawl" aria-hidden="true">
          <div className="sb-crawl-track">
            {[0, 1].map((copy) => (
              <span className="sb-crawl-run" key={copy}>
                {(known?.tape ?? []).map((f) => (
                  <span className="sb-crawl-item" key={`${copy}-${f.seal}-${f.at}`}>
                    <span className={f.side === 'buy' ? 'up' : 'dn'}>{f.side}</span>
                    <span className="sb-crawl-mint">{f.mint.slice(0, 4)}…{f.mint.slice(-4)}</span>
                    <span className="sb-crawl-sol">{sol(f.sol)} SOL</span>
                    <span className="sb-crawl-seal">{f.seal}</span>
                  </span>
                ))}
                {(known?.tape.length ?? 0) === 0 && (
                  <span className="sb-crawl-item">
                    <span className="sb-crawl-mint">{known ? 'no fills yet' : 'waiting for the first read'}</span>
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>

        <footer className="sb-foot">
          <span className="sb-foot-url">probatiotrade.com</span>
          <span className="sb-foot-sep" aria-hidden="true" />
          <span className="sb-foot-note">Open source · Every fill sealed · Paper money only</span>
        </footer>
      </div>
    </div>
  );
}
