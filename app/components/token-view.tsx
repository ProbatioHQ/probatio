'use client';

import { useEffect, useState } from 'react';
import { DexChart } from '@/components/dex-chart';
import { PriceChart, TIMEFRAME_LABELS } from '@/components/price-chart';
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

const TIMEFRAMES = ['s15', 'm1', 'm5', 'm15', 'h1'] as const;

/** Bucket sizes, in seconds, matching TIMEFRAMES. */
const BUCKET_SECONDS: Record<string, number> = {
  s15: 15,
  m1: 60,
  m5: 300,
  m15: 900,
  h1: 3_600,
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
   * TradingView when the pair is indexed, because it is what a trader already
   * knows how to use. The native chart when it is not — which is every token
   * for its first few minutes, and those are the ones this site is most about.
   * Getting this the wrong way round means an empty frame on exactly the
   * tokens people came to look at.
   */
  const [indexed, setIndexed] = useState(dexIndexed);
  const [source, setSource] = useState<'tradingview' | 'native'>(
    dexIndexed ? 'tradingview' : 'native',
  );
  /** True once the reader has chosen for themselves; we stop choosing for them. */
  const [chosen, setChosen] = useState(false);

  // A token minutes old gets indexed while somebody is looking at it. Noticing
  // beats making them reload to find out.
  useEffect(() => {
    if (indexed) return;
    const timer = setInterval(() => {
      void fetch(`/api/chart-source?mint=${encodeURIComponent(mint)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { indexed?: boolean } | null) => {
          if (!body?.indexed) return;
          setIndexed(true);
          // Only switches if they have not picked a chart themselves. Pulling
          // the chart out from under someone reading it is worse than leaving
          // them on the one they chose.
          if (!chosen) setSource('tradingview');
        })
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [indexed, mint, chosen]);
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
                    : 'DEX Screener has not indexed this token yet — it usually takes a few minutes after launch'
                }
                onClick={() => {
                  setChosen(true);
                  setSource('tradingview');
                }}
              >
                TRADINGVIEW
              </button>
              <button
                type="button"
                className={source === 'native' ? 'on' : undefined}
                aria-pressed={source === 'native'}
                onClick={() => {
                  setChosen(true);
                  setSource('native');
                }}
              >
                NATIVE
              </button>
            </div>

            {/* TradingView carries its own timeframe and unit controls, so
                showing ours beside them would be two sets of switches for one
                chart, disagreeing. */}
            {source === 'native' && (
            <>
            <div role="group" aria-label="Timeframe" className="segmented">
              {TIMEFRAMES.map((frame) => (
                <button
                  key={frame}
                  type="button"
                  className={frame === timeframe ? 'on' : undefined}
                  aria-pressed={frame === timeframe}
                  onClick={() => {
                    setTimeframeChosen(true);
                    setTimeframe(frame);
                  }}
                >
                  {TIMEFRAME_LABELS[frame] ?? frame}
                </button>
              ))}
            </div>
            <div role="group" aria-label="Unit" className="segmented">
              <button
                type="button"
                className={unit === 'market-cap' ? 'on' : undefined}
                aria-pressed={unit === 'market-cap'}
                onClick={() => setUnit('market-cap')}
              >
                MCAP
              </button>
              <button
                type="button"
                className={unit === 'per-token' ? 'on' : undefined}
                aria-pressed={unit === 'per-token'}
                onClick={() => setUnit('per-token')}
              >
                PRICE
              </button>
            </div>
            </>
            )}
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
                Your fills are quoted against the reserves this site reads directly —{' '}
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
                unit={unit}
                height={560}
                onHistory={({ candles, spanSeconds }) => {
                  if (timeframeChosen) return;
                  const fitted = fitTimeframe(candles, spanSeconds);
                  // Only ever moved once, and never over a choice the reader made.
                  if (fitted && fitted !== timeframe) {
                    setTimeframeChosen(true);
                    setTimeframe(fitted);
                  }
                }}
              />
              <p className="dim chart-note">
                {indexed ? (
                  <>
                    Built from the reserves this site reads directly — the same ones your fills
                    are quoted against.{' '}
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => {
                        setChosen(true);
                        setSource('tradingview');
                      }}
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
          information — the trade panel beside it already says how to sign in. */}
      {signedIn && (
        <div className="positions-slot">
          <Positions refreshKey={tradeCount} />
        </div>
      )}
    </div>
  );
}
