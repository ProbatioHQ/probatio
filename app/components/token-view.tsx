'use client';

import { useState } from 'react';
import { PriceChart, TIMEFRAME_LABELS } from '@/components/price-chart';
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
  const [tradeCount, setTradeCount] = useState(0);
  const [timeframe, setTimeframe] = useState<string>('m1');
  const [unit, setUnit] = useState<PriceUnit>('market-cap');

  return (
    <div className="trade-layout">
      <section className="term chart-panel">
        <div className="term-bar">
          <span className="prompt">~/chart</span>
          <div className="chart-controls">
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
          </div>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <PriceChart mint={mint} timeframe={timeframe} unit={unit} height={420} />
        </div>
      </section>

      <TradePanel mint={mint} onTraded={() => setTradeCount((n) => n + 1)} />

      <div className="positions-slot">
        <Positions refreshKey={tradeCount} />
      </div>
    </div>
  );
}
