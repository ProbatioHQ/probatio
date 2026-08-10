'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { minMoveFor, precisionFor, toDisplay, type PriceUnit } from '@/lib/price-display';

/**
 * The price chart.
 *
 * The library is created inside an effect rather than at module scope because
 * it needs a real DOM node, and a Next server render has none.
 */

interface RawCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  trades: number;
}

interface CandleResponse {
  mint: string;
  timeframe: string;
  tokenDecimals: number;
  totalSupply: string;
  candles: RawCandle[];
}

export const TIMEFRAME_LABELS: Record<string, string> = {
  s1: '1s',
  s5: '5s',
  s15: '15s',
  m1: '1m',
  m5: '5m',
  m15: '15m',
  h1: '1h',
};

export function PriceChart({
  mint,
  timeframe = 'm1',
  unit = 'market-cap',
  height = 360,
}: {
  mint: string;
  timeframe?: string;
  unit?: PriceUnit;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const [data, setData] = useState<CandleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    const read = (): void => {
      void fetch(`/api/candles?mint=${encodeURIComponent(mint)}&timeframe=${timeframe}`)
        .then(async (response) => {
          const body = (await response.json()) as CandleResponse | { error: string };
          if (cancelled) return;
          if ('error' in body) {
            setError(body.error);
            return;
          }
          setError(null);
          setData(body);
        })
        .catch(() => {
          // Only the first failure is worth reporting. A dropped poll on a
          // chart that is already drawn should not replace it with an error.
          if (!cancelled && !data) setError('Could not load the chart.');
        });
    };

    read();
    // A chart on a live market that only updates on reload is a screenshot.
    // Short timeframes move faster and are polled faster.
    const period = timeframe.startsWith('s') ? 3_000 : 8_000;
    const timer = setInterval(read, period);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, timeframe]);

  const points = useMemo<CandlestickData[]>(() => {
    if (!data) return [];
    return data.candles.map((candle) => ({
      time: candle.time as UTCTimestamp,
      open: toDisplay(candle.open, unit, data.tokenDecimals, data.totalSupply),
      high: toDisplay(candle.high, unit, data.tokenDecimals, data.totalSupply),
      low: toDisplay(candle.low, unit, data.tokenDecimals, data.totalSupply),
      close: toDisplay(candle.close, unit, data.tokenDecimals, data.totalSupply),
    }));
  }, [data, unit]);

  useEffect(() => {
    const node = container.current;
    if (!node) return;

    const instance = createChart(node, {
      height,
      // Matched to the site's own tokens rather than the library defaults,
      // so the chart belongs to the page it sits in.
      layout: {
        background: { color: 'transparent' },
        textColor: '#6b7280',
        fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(63,224,138,0.05)' },
        horzLines: { color: 'rgba(63,224,138,0.05)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(63,224,138,0.4)', labelBackgroundColor: '#1d7a4a' },
        horzLine: { color: 'rgba(63,224,138,0.4)', labelBackgroundColor: '#1d7a4a' },
      },
    });

    const candles = instance.addSeries(CandlestickSeries, {
      upColor: '#3fe08a',
      downColor: '#ff5f56',
      borderVisible: false,
      wickUpColor: '#3fe08a',
      wickDownColor: '#ff5f56',
    });

    chart.current = instance;
    series.current = candles;

    // The library does not observe its own container, so a resized window
    // leaves the canvas at its old width until something forces a redraw.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) instance.applyOptions({ width });
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      instance.remove();
      chart.current = null;
      series.current = null;
    };
  }, [height]);

  useEffect(() => {
    if (!series.current || points.length === 0) return;

    // Precision is chosen from the data rather than fixed: two decimals turns a
    // memecoin chart into a flat line at zero, and twelve makes a graduated
    // token unreadable.
    const precision = precisionFor(points.flatMap((point) => [point.low, point.high]));
    series.current.applyOptions({
      priceFormat: { type: 'price', precision, minMove: minMoveFor(precision) },
    });

    series.current.setData(points);

    // Only on the first draw. Refitting on every poll would yank the view back
    // to the whole range each time somebody zoomed in to look at something.
    if (!fitted.current) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [points]);

  // A new token or timeframe is a new chart, so it earns a fresh fit.
  useEffect(() => {
    fitted.current = false;
  }, [mint, timeframe]);

  const last = points.at(-1);
  const first = points.at(0);
  const change =
    last && first && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null;

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="cmd">
          {unit === 'market-cap' ? 'market cap' : 'price'}
          <span className="caret" />
        </span>
        {change !== null && (
          <span className={change >= 0 ? 'gain mono' : 'loss mono'}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(2)}%
          </span>
        )}
      </div>
      <div className="chart-canvas" style={{ height }}>
        <div ref={container} style={{ width: '100%', height }} />
        {/* Centred in the plot area rather than under it. An empty 420px box
            with a caption below reads as a chart that failed to load. */}
        {(error || (data && points.length === 0)) && (
          <p role={error ? 'alert' : undefined} className={error ? 'chart-empty loss' : 'chart-empty dim'}>
            {error ?? 'No trades yet. The chart fills in as this token trades.'}
          </p>
        )}
      </div>
    </div>
  );
}
