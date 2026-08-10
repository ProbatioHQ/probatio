'use client';

import { useState } from 'react';
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

export function TokenView({ mint }: { mint: string }) {
  const { status } = useWallet();
  const signedIn = status === 'signed-in';
  const [tradeCount, setTradeCount] = useState(0);
  // Fifteen seconds, not a minute. These tokens do their whole life in
  // minutes — a fast one puts sixty trades inside a single 1m bucket, which
  // draws as one candle and looks like a chart that is not working.
  const [timeframe, setTimeframe] = useState<string>('s15');
  /**
   * TradingView first, because it is what a trader already knows how to use.
   * The native chart stays one click away: it is drawn from the same reserves
   * this site quotes fills against, which is the chart the product's claims are
   * actually about.
   */
  const [source, setSource] = useState<'tradingview' | 'native'>('tradingview');
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
                  onClick={() => setTimeframe(frame)}
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
            <PriceChart mint={mint} timeframe={timeframe} unit={unit} height={560} />
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
