'use client';

import { useCallback, useEffect, useState } from 'react';
import { DexChart } from '@/components/dex-chart';
import { PriceChart } from '@/components/price-chart';
import { useWallet } from '@/components/wallet';
import { Positions } from '@/components/positions';
import { RuleBacktest } from '@/components/rule-backtest';
import { TradePanel } from '@/components/trade-panel';
import type { PriceUnit } from '@/lib/price-display';
import { Sprout, age, freshAge } from '@/components/sprout';
import { imageSrc } from '@/lib/image-src';

/**
 * The trading surface for one token.
 *
 * Chart and panel side by side, positions underneath. The layout is the point:
 * the two things a trader looks at while deciding have to be on screen at once,
 * and a fill has to refresh the position beside it or they are left reading a
 * balance that is already wrong.
 */

const TIMEFRAMES = ['s15', 'm1', 'm5', 'm15', 'h1', 'h4', 'h12', 'd1', 'w1', 'mo1'] as const;

/** Bucket sizes, in seconds, matching TIMEFRAMES. */
const BUCKET_SECONDS: Record<string, number> = {
  s15: 15,
  m1: 60,
  m5: 300,
  m15: 900,
  h1: 3_600,
  h4: 14_400,
  h12: 43_200,
  d1: 86_400,
  w1: 604_800,
  mo1: 2_592_000,
};

/**
 * The bucket size that suits a token's actual trading.
 *
 * A chart reads well when its candles are mostly adjacent. Too fine and the
 * trades scatter into isolated slivers with hours of empty grid between them;
 * too coarse and a whole session collapses into three candles. Aiming for
 * roughly one bucket per candle of real activity puts a token's history across
 * a sensible number of buckets whether it has traded for four minutes or four
 * days.
 */
function fitTimeframe(candles: number, spanSeconds: number): string | null {
  if (candles < 2 || spanSeconds <= 0) return null;
  const wanted = spanSeconds / Math.min(120, Math.max(20, candles));

  let best: string | null = null;
  let closest = Number.POSITIVE_INFINITY;
  for (const frame of TIMEFRAMES) {
    const distance = Math.abs(Math.log(BUCKET_SECONDS[frame]! / wanted));
    if (distance < closest) {
      closest = distance;
      best = frame;
    }
  }
  return best;
}

export interface TokenHead {
  readonly name: string;
  readonly symbol: string | null;
  readonly image: string | null;
  readonly launchedAt: number | null;
  readonly shortMint: string;
  /**
   * Where the launcher said to find them, or nulls.
   *
   * Their claims about themselves, not ours about them: on one real token the
   * "website" is an x.com link. Shown so a reader can go and judge, never
   * described as verified, and absent entirely when there is nothing to show
   * rather than rendered as a dead icon.
   */
  readonly links: {
    readonly twitter: string | null;
    readonly website: string | null;
    readonly telegram: string | null;
  };
}

export function TokenView({
  mint,
  dexIndexed,
  head,
}: {
  mint: string;
  /** Whether DEX Screener has a pair for this token yet. */
  dexIndexed: boolean;
  /**
   * Who this token is, resolved on the server.
   *
   * Rendered here rather than by the page above it so that the live market cap
   * can sit on the same row as the name, which is where a phone needs it. The
   * page still resolves the facts; it just hands them down instead of drawing
   * them, because only this component knows what the price is doing.
   */
  head: TokenHead;
}) {
  const { status } = useWallet();
  const signedIn = status === 'signed-in';
  const [tradeCount, setTradeCount] = useState(0);

  /*
   * What this holding cost per token, for the line the chart draws at it.
   *
   * Derived from the position rather than remembered from a fill: an average
   * over everything bought is what a second buy at a different price makes of
   * an entry, and a receipt only knows about one trade. Scaled the way every
   * price in the store is, so the chart converts it with the candles.
   */
  const [entryPrice, setEntryPrice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void fetch('/api/positions', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then(
          (
            body: {
              positions?: { mint: string; tokenAmount: string; costBasis: string }[];
            } | null,
          ) => {
            if (cancelled) return;
            const open = body?.positions?.find((entry) => entry.mint === mint);
            if (!open || BigInt(open.tokenAmount) === 0n) {
              setEntryPrice(null);
              return;
            }
            setEntryPrice(
              ((BigInt(open.costBasis) * 10n ** 18n) / BigInt(open.tokenAmount)).toString(),
            );
          },
        )
        .catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [mint, tradeCount]);

  /*
   * Fifteen seconds to begin with, because a token doing its whole life in
   * minutes puts sixty trades inside one 1m bucket and draws as a single
   * candle. That is right for the token this site is most about and wrong for
   * every token older than an afternoon, which is what the reader actually
   * complained about: a day-old coin at fifteen-second candles filled 49 of
   * 7,262 slots — under one percent — and drew as scattered dashes across an
   * empty grid. The same token at hourly candles filled 61% and looked like a
   * chart.
   *
   * So this is only the opening guess. Once the first load says how much
   * history there is, `fitTimeframe` picks a bucket that suits this token, and
   * stops as soon as the reader picks one themselves.
   */
  const [timeframe, setTimeframe] = useState<string>('s15');
  const [timeframeChosen, setTimeframeChosen] = useState(false);

  /*
   * A different token is a different question.
   *
   * Both of these are answers about the token on screen, and neither survives
   * moving to another one. Left alone, opening a busy coin and then a quiet one
   * carried the busy coin's answer across: the quiet token never got fitted,
   * and drew as the scattered dashes this was supposed to have fixed. The
   * reader's own choice is theirs for that token, not for every token after it.
   */
  useEffect(() => {
    setTimeframeChosen(false);
    setTimeframe('s15');
  }, [mint]);
  /**
   * Whichever chart has data.
   *
   * The native chart is the default now that it carries a token's whole history
   * from the chain, every timeframe from seconds to a month, and the token's
   * logo. It used to default to the DEX Screener TradingView embed for indexed
   * tokens, but that embed loads a stranger's page into an iframe, which drags
   * its own analytics, service worker, and cross-origin errors into the console
   * on exactly the tokens people came to look at. TradingView stays a click
   * away for anyone who prefers it; it just no longer loads unasked.
   */
  const [indexed, setIndexed] = useState(dexIndexed);
  const [source, setSource] = useState<'tradingview' | 'native'>('native');

  // A token minutes old gets indexed while somebody is looking at it. Noticing
  // enables the TradingView button, but does not switch onto it: the native
  // chart is the default, and pulling the embed in unasked is what put another
  // site's console errors on the page.
  useEffect(() => {
    if (indexed) return;
    let cancelled = false;
    /*
     * Asked at once, then kept asking.
     *
     * This used to set an interval and nothing else, so the first answer came
     * thirty seconds after the page opened. That was survivable while the
     * server resolved it before rendering and the page arrived knowing. It no
     * longer does — that lookup was a call to another company's server sitting
     * in front of every token page, and taking it out is what made these open
     * in under a second — so the browser is now the only thing that asks, and
     * waiting half a minute to ask meant the TradingView tab sat disabled on
     * tokens it works perfectly well for.
     */
    const check = (): void => {
      void fetch(`/api/chart-source?mint=${encodeURIComponent(mint)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { indexed?: boolean } | null) => {
          if (!cancelled && body?.indexed) setIndexed(true);
        })
        .catch(() => undefined);
    };

    check();
    // A token minutes old gets indexed while somebody is looking at it.
    const timer = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [indexed, mint]);
  const [unit, setUnit] = useState<PriceUnit>('market-cap');

  /*
   * The chart's height, which a phone cannot take a fixed number for.
   *
   * It was hard-coded at 560, chosen for a desktop where the panel sits beside
   * the chart rather than under it. On a 390x844 screen that is two thirds of
   * the viewport before the token's own name, so the price and the buy button
   * were both below the fold and the page opened on a wall of candles.
   *
   * Measured rather than guessed at through a breakpoint, and re-measured on
   * rotate, since a phone turned sideways is a different chart entirely.
   */
  /*
   * The latest market cap and its move, as the chart sees them.
   *
   * Taken from the chart rather than read again, so the figure beside the name
   * and the last candle can never disagree. Held in a ref-stable callback or
   * the chart would report on every render of this component.
   */
  const [quote, setQuote] = useState<{ value: number | null; change: number | null }>({
    value: null,
    change: null,
  });
  const onQuote = useCallback(
    (next: { value: number | null; change: number | null }) => setQuote(next),
    [],
  );

  const [chartHeight, setChartHeight] = useState(560);
  useEffect(() => {
    /*
     * Re-measured on a width change, never on a height change.
     *
     * The first version watched `resize` and read `window.innerHeight`. On iOS
     * that value moves every time the URL bar collapses or expands, which is
     * constantly while scrolling, so the chart's height changed on every scroll
     * frame. Paired with a chart that rebuilt itself on a height change, that
     * was the flicker.
     *
     * Width is the only thing worth reacting to here: it changes on rotation
     * and on nothing else, and rotation genuinely is a different chart. The
     * height is derived from the viewport once, at that width.
     */
    let lastWidth = -1;
    const measure = (): void => {
      const width = window.innerWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      setChartHeight(
        width > 860 ? 560 : Math.round(Math.min(420, Math.max(260, window.innerHeight * 0.44))),
      );
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, []);

  /*
   * The source switch, defined once and rendered in two places.
   *
   * On a wide screen it belongs in the panel's title bar, at the top of the
   * chart's own furniture. On a phone that bar is a row of its own above a
   * second row holding the timeframe and Indicators, which is two lines and
   * three groups for four controls that are all about the same chart.
   *
   * It cannot be one element in both positions: the bar belongs to this
   * component and the row belongs to the chart. So it is one definition
   * rendered twice, and CSS shows whichever one suits the width. Both drive
   * the same state, so they can never disagree.
   */
  const sourceSwitch = (
    <div role="group" aria-label="Chart source" className="segmented">
      <button
        type="button"
        className={source === 'tradingview' ? 'on' : undefined}
        aria-pressed={source === 'tradingview'}
        disabled={!indexed}
        title={
          indexed
            ? undefined
            : 'DEX Screener has not indexed this token yet. It usually takes a few minutes after launch'
        }
        onClick={() => setSource('tradingview')}
      >
        TRADINGVIEW
      </button>
      <button
        type="button"
        className={source === 'native' ? 'on' : undefined}
        aria-pressed={source === 'native'}
        onClick={() => setSource('native')}
      >
        NATIVE
      </button>
    </div>
  );

  const changed = quote.change;

  /* Ticks so the age in the bar stays honest on a page left open. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const launched = head.launchedAt ?? 0;

  // Pointed at a gateway that serves browsers, and allowed to give up cleanly.
  const heroSrc = imageSrc(head.image);
  const [heroBroken, setHeroBroken] = useState(false);

  return (
    <>
      {/*
        The bar above the token, which only a phone shows.

        A wide screen has the site header, a back button in the browser chrome
        and a whole page of context around the token. A phone has none of that:
        the page fills the screen, so it carries its own way out and says which
        token you are looking at while you are scrolled into the chart.
      */}
      <div className="token-bar">
        <button
          type="button"
          className="token-back"
          aria-label="Back"
          onClick={() => {
            // Back where there is somewhere to go back to, and the feed
            // otherwise, so a token opened from a shared link is not a dead end.
            if (window.history.length > 1) window.history.back();
            else window.location.href = '/feed';
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
        <span className="token-bar-sym">{head.symbol ?? head.name}</span>
        {launched > 0 && (
          <span className={freshAge(launched, now) ? 'token-bar-age new' : 'token-bar-age'}>
            <Sprout />
            {age(launched, now)}
          </span>
        )}
      </div>

      {/*
        Who the token is, and what it is worth, on one row.

        The market cap and its move sit at the end of that row rather than
        under the chart, because on a phone they are the two things somebody
        opens a token to see and the chart is what they look at afterwards.
      */}
      <div className="token-head">
        {heroSrc && !heroBroken ? (
          // Not next/image: an arbitrary host chosen by whoever launched the
          // token, rendered by the browser and never fetched by this server.
          //
          // onError matters here and was missing: without it a picture that
          // fails leaves the browser's own torn-page glyph sitting where the
          // token's face should be, which is uglier than having no picture and
          // reads as this page being broken rather than that one being absent.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="token-hero"
            src={heroSrc}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setHeroBroken(true)}
          />
        ) : (
          <span className="token-hero placeholder" aria-hidden="true" />
        )}

        <div className="token-title">
          <h1>
            {head.symbol ?? head.name}
            {head.symbol && head.name !== head.symbol && <span className="dim"> {head.name}</span>}
          </h1>
          <p className="mono dim token-meta">
            <span>{head.shortMint}</span>
            {/* Only what exists. A launcher who gave no telegram gets no
                telegram icon, rather than one that goes nowhere. */}
            {head.links.twitter && (
              <a
                className="token-social"
                href={head.links.twitter}
                target="_blank"
                rel="noreferrer noopener nofollow"
                aria-label="The launcher's X account"
                title="Posted by whoever launched this token"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
                </svg>
              </a>
            )}
            {head.links.website && (
              <a
                className="token-social"
                href={head.links.website}
                target="_blank"
                rel="noreferrer noopener nofollow"
                aria-label="The launcher's website"
                title="Given by whoever launched this token"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" strokeLinecap="round" />
                </svg>
              </a>
            )}
            {head.links.telegram && (
              <a
                className="token-social"
                href={head.links.telegram}
                target="_blank"
                rel="noreferrer noopener nofollow"
                aria-label="The launcher's Telegram"
                title="Given by whoever launched this token"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.3 13.2l-4.8-1.5c-1-.3-1-1 .2-1.5l18.8-7.2c.9-.3 1.6.2 1.4 1.3z" />
                </svg>
              </a>
            )}
            {head.launchedAt !== null && (
              <>
                <span className="sep" aria-hidden="true" />
                <span>launched {new Date(head.launchedAt).toLocaleDateString()}</span>
              </>
            )}
            <span className="sep" aria-hidden="true" />
            <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noopener noreferrer">
              pump.fun
            </a>
          </p>
        </div>

        {/* Only once the chart has something to say. An empty slot holding a
            dash where a market cap goes reads as a token worth nothing. */}
        {quote.value !== null && (
          <div className="token-quote">
            <span className="token-quote-cap">{formatQuote(quote.value)}</span>
            {changed !== null && (
              <span className={changed >= 0 ? 'token-quote-move gain' : 'token-quote-move loss'}>
                {changed >= 0 ? '+' : ''}
                {changed.toFixed(1)}%
              </span>
            )}
          </div>
        )}
      </div>

    <div className="trade-layout">
      <section className="term chart-panel">
        <div className="term-bar">
          <span className="prompt">~/chart</span>
          <div className="chart-controls chart-controls-bar">
            {sourceSwitch}
            {/* Timeframe, unit, and indicators live in the chart's own left rail
                now, the way a trading terminal keeps them, so they are not
                repeated here. TradingView carries its own. */}
          </div>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          {source === 'tradingview' ? (
            <>
              <DexChart mint={mint} height={chartHeight + 60} />
              <p className="dim chart-note">
                TradingView charts, with pump.fun and PumpSwap trades, served by DEX Screener.
                Your fills are quoted against the reserves this site reads directly, and you can{' '}
                <button type="button" className="linklike" onClick={() => setSource('native')}>
                  see that chart
                </button>
                .
              </p>
            </>
          ) : (
            <>
              <PriceChart
                mint={mint}
                timeframe={timeframe}
                timeframes={TIMEFRAMES}
                onTimeframe={(frame) => {
                  setTimeframeChosen(true);
                  setTimeframe(frame);
                }}
                unit={unit}
                onUnit={setUnit}
                entryPrice={entryPrice}
                height={chartHeight}
                onQuote={onQuote}
                sourceSwitch={sourceSwitch}
                onHistory={({ candles, spanSeconds, backfilling }) => {
                  // The reader's own pick wins and ends the fitting for good.
                  if (timeframeChosen) return;
                  const fitted = fitTimeframe(candles, spanSeconds);
                  if (fitted && fitted !== timeframe) {
                    // Switch, but do not lock on the same poll: the frame we are
                    // moving to was chosen from the previous frame's candle
                    // count, so let its own data confirm the fit next poll
                    // before committing to it.
                    setTimeframe(fitted);
                    return;
                  }
                  // Keep re-fitting while the history is still walking in, then
                  // lock once it is all here and the frame agrees with its own
                  // data. Fitting on the first poll alone sized the chart to the
                  // two or three candles that arrived before the backfill landed
                  // and never corrected, which is how a token with minutes of
                  // history showed as a couple of candles at the wrong bucket.
                  if (!backfilling) setTimeframeChosen(true);
                }}
              />
              <p className="dim chart-note">
                {indexed ? (
                  <>
                    Built from the reserves this site reads directly, the same ones your fills
                    are quoted against.{' '}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setSource('tradingview')}
                    >
                      Switch to TradingView
                    </button>
                    .
                  </>
                ) : (
                  <>
                    This token is too new for DEX Screener to have indexed, so TradingView has
                    nothing to draw yet. This chart is built from the launch feed&apos;s own trade
                    stream and works from the first trade. TradingView turns on here by itself
                    once the pair appears.
                  </>
                )}
              </p>
            </>
          )}
        </div>
      </section>

      <TradePanel mint={mint} onTraded={() => setTradeCount((n) => n + 1)} />

      {/* Under the trade panel rather than under the chart. Somebody asks what a
          rule would have done after they have looked at the price and thought
          about buying, not instead of it. */}
      <RuleBacktest mint={mint} />

      {/* Only once there is something to show. A bare line of text reading
          "sign in to see your positions" under a chart is furniture, not
          information, and the trade panel beside it already says how to sign in. */}
      {signedIn && (
        <div className="positions-slot">
          <Positions refreshKey={tradeCount} />
        </div>
      )}
    </div>
    </>
  );
}

/**
 * The market cap beside a token's name.
 *
 * Abbreviated the way every other client abbreviates it, because the row it
 * sits on has a name competing for the same width and "$1,412,338" would win
 * that fight for no benefit.
 */
function formatQuote(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}
