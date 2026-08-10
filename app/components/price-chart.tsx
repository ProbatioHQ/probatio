'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { minMoveFor, precisionFor, toDisplay, type PriceUnit } from '@/lib/price-display';

/**
 * The price chart.
 *
 * The library is created inside an effect rather than at module scope because
 * it needs a real DOM node, and a Next server render has none.
 *
 * Not TradingView, and not for want of trying: their widget only charts symbols
 * listed on the exchanges it knows about, and a pump.fun mint that came into
 * existence ninety seconds ago is on none of them. Their Advanced Charts
 * library, which can take custom data, is licensed and not redistributable. So
 * the indicators and the drawing are built here on top of the same series.
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
  backfilling?: boolean;
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

/** Moving averages, in candles. The two most-watched lengths. */
const MA_PERIODS = [9, 21] as const;
const MA_COLOURS: Record<number, string> = { 9: '#f0b429', 21: '#5b8def' };

/** A simple moving average over closes, aligned to the candle it closes on. */
function movingAverage(points: readonly CandlestickData[], period: number): LineData[] {
  if (points.length < period) return [];

  const out: LineData[] = [];
  let sum = 0;

  for (let index = 0; index < points.length; index += 1) {
    sum += points[index]!.close;
    if (index >= period) sum -= points[index - period]!.close;
    if (index >= period - 1) {
      out.push({ time: points[index]!.time, value: sum / period });
    }
  }
  return out;
}

export function PriceChart({
  mint,
  timeframe = 'm1',
  unit = 'market-cap',
  height = 560,
}: {
  mint: string;
  timeframe?: string;
  unit?: PriceUnit;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const averages = useRef(new Map<number, ISeriesApi<'Line'>>());
  const priceLines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);

  const [data, setData] = useState<CandleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showVolume, setShowVolume] = useState(true);
  const [showMa, setShowMa] = useState(true);
  const [drawing, setDrawing] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;

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

  const volumes = useMemo<HistogramData[]>(() => {
    if (!data) return [];
    return data.candles.map((candle, index) => {
      const rising = points[index] ? points[index]!.close >= points[index]!.open : true;
      return {
        time: candle.time as UTCTimestamp,
        value: Number(BigInt(candle.volume)) / 1e9,
        color: rising ? 'rgba(63,224,138,0.35)' : 'rgba(255,95,86,0.35)',
      };
    });
  }, [data, points]);

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
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
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

    // Its own scale, pinned to the bottom quarter, so volume never competes
    // with price for the vertical space that matters.
    const bars = instance.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    instance.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
      borderVisible: false,
    });

    chart.current = instance;
    series.current = candles;
    volume.current = bars;

    for (const period of MA_PERIODS) {
      averages.current.set(
        period,
        instance.addSeries(LineSeries, {
          color: MA_COLOURS[period],
          lineWidth: 1,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        }),
      );
    }

    // A click while drawing leaves a horizontal line at that price. It is the
    // one drawing tool that earns its place on a chart this size — a level you
    // are watching, marked, and still there when the candles reach it.
    const onClick = (param: { point?: { x: number; y: number } }): void => {
      if (!drawingRef.current || !param.point || !series.current) return;
      const price = series.current.coordinateToPrice(param.point.y);
      if (price === null) return;

      priceLines.current.push(
        series.current.createPriceLine({
          price: price as number,
          color: '#f0b429',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '',
        }),
      );
      setLineCount(priceLines.current.length);
    };
    instance.subscribeClick(onClick);

    // The library does not observe its own container, so a resized window
    // leaves the canvas at its old width until something forces a redraw.
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) instance.applyOptions({ width });
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
      instance.unsubscribeClick(onClick);
      instance.remove();
      chart.current = null;
      series.current = null;
      volume.current = null;
      averages.current.clear();
      priceLines.current = [];
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
    volume.current?.setData(showVolume ? volumes : []);

    for (const period of MA_PERIODS) {
      averages.current.get(period)?.setData(showMa ? movingAverage(points, period) : []);
    }

    // Only on the first draw. Refitting on every poll would yank the view back
    // to the whole range each time somebody zoomed in to look at something.
    if (!fitted.current) {
      const scale = chart.current?.timeScale();
      const width = container.current?.clientWidth ?? 0;
      // How many candles would fit at a sensible width. Fitting three of them
      // to a wide canvas draws three enormous blocks that read as a rendering
      // fault rather than as a token minutes old; pinning them to the right
      // instead leaves a wall of empty space where history would be.
      const comfortable = Math.floor(width / 12);

      if (points.length > 0 && points.length < comfortable) {
        // Data from the left, room to the right. The chart is filling forward,
        // and that is what it should look like.
        scale?.setVisibleLogicalRange({ from: -0.5, to: comfortable });
      } else {
        scale?.fitContent();
      }
      fitted.current = true;
    }
  }, [points, volumes, showVolume, showMa]);

  // A new token or timeframe is a new chart, so it earns a fresh fit.
  useEffect(() => {
    fitted.current = false;
  }, [mint, timeframe]);

  const clearLines = useCallback(() => {
    for (const line of priceLines.current) series.current?.removePriceLine(line);
    priceLines.current = [];
    setLineCount(0);
  }, []);

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

        <div className="chart-tools">
          <button
            type="button"
            className={showMa ? 'chip on' : 'chip'}
            onClick={() => setShowMa((was) => !was)}
            aria-pressed={showMa}
          >
            MA 9/21
          </button>
          <button
            type="button"
            className={showVolume ? 'chip on' : 'chip'}
            onClick={() => setShowVolume((was) => !was)}
            aria-pressed={showVolume}
          >
            Volume
          </button>
          <button
            type="button"
            className={drawing ? 'chip on' : 'chip'}
            onClick={() => setDrawing((was) => !was)}
            aria-pressed={drawing}
            title="Click the chart to mark a price level"
          >
            Level
          </button>
          {lineCount > 0 && (
            <button type="button" className="chip" onClick={clearLines}>
              Clear {lineCount}
            </button>
          )}
        </div>

        {change !== null && (
          <span className={change >= 0 ? 'gain mono chart-change' : 'loss mono chart-change'}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(2)}%
          </span>
        )}
      </div>

      <div className={drawing ? 'chart-canvas drawing' : 'chart-canvas'} style={{ height }}>
        <div ref={container} style={{ width: '100%', height }} />
        {/* Centred in the plot area rather than under it. An empty box with a
            caption below reads as a chart that failed to load. */}
        {(error || (data && points.length === 0)) && (
          <p
            role={error ? 'alert' : undefined}
            className={error ? 'chart-empty loss' : 'chart-empty dim'}
          >
            {error ??
              (data?.backfilling
                ? 'Reading this token’s history from the chain…'
                : 'No trades on this token yet. The chart fills in as it trades.')}
          </p>
        )}
      </div>

      {drawing && (
        <p className="dim chart-hint">Click anywhere on the chart to mark a price level.</p>
      )}
    </div>
  );
}
