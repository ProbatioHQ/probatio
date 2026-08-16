'use client';

import { useEffect, useState } from 'react';
import { DexChart } from '@/components/dex-chart';
import { PriceChart } from '@/components/price-chart';
import { useWallet } from '@/components/wallet';
import { Positions } from '@/components/positions';
import { TradePanel } from '@/components/trade-panel';
import type { PriceUnit } from '@/lib/price-display';

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

export function TokenView({
  mint,
  dexIndexed,
}: {
  mint: string;
  /** Whether DEX Screener has a pair for this token yet. */
  dexIndexed: boolean;
}) {
  const { status } = useWallet();
  const signedIn = status === 'signed-in';
  const [tradeCount, setTradeCount] = useState(0);
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
    const timer = setInterval(() => {
      void fetch(`/api/chart-source?mint=${encodeURIComponent(mint)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { indexed?: boolean } | null) => {
          if (body?.indexed) setIndexed(true);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [indexed, mint]);
  const [unit, setUnit] = useState<PriceUnit>('market-cap');

  return (
    <div className="trade-layout">
      <section className="term chart-panel">
        <div className="term-bar">
          <span className="prompt">~/chart</span>
          <div className="chart-controls">
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
              <DexChart mint={mint} height={620} />
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
                height={560}
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

      {/* Only once there is something to show. A bare line of text reading
          "sign in to see your positions" under a chart is furniture, not
          information, and the trade panel beside it already says how to sign in. */}
      {signedIn && (
        <div className="positions-slot">
          <Positions refreshKey={tradeCount} />
        </div>
      )}
    </div>
  );
}
