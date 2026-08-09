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
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const [data, setData] = useState<CandleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void fetch(`/api/candles?mint=${encodeURIComponent(mint)}&timeframe=${timeframe}`)
      .then(async (response) => {
        const body = (await response.json()) as CandleResponse | { error: string };
        if (cancelled) return;
        if ('error' in body) {
          setError(body.error);
          return;
        }
        setData(body);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the chart.');
      });

    return () => {
      cancelled = true;
    };
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
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b8b93',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(140,140,150,0.08)' },
        horzLines: { color: 'rgba(140,140,150,0.08)' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    const candles = instance.addSeries(CandlestickSeries, {
      upColor: '#26a37b',
      downColor: '#d1495b',
      borderVisible: false,
      wickUpColor: '#26a37b',
      wickDownColor: '#d1495b',
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
    chart.current?.timeScale().fitContent();
  }, [points]);

  return (
    <div>
      <div ref={container} style={{ width: '100%', height }} />
      {error && <p role="alert">{error}</p>}
      {!error && data && points.length === 0 && (
        <p>No trades yet. The chart fills in as this token trades.</p>
      )}
    </div>
  );
}
