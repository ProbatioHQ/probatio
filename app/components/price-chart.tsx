'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type AutoscaleInfo,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { minMoveFor, precisionFor, toDisplay, type PriceUnit } from '@/lib/price-display';
import { bollinger, ema, macd, rsi, sma, vwap, type Bar } from '@/lib/indicators';

/**
 * The price chart.
 *
 * The library is created inside an effect rather than at module scope because
 * it needs a real DOM node, and a Next server render has none.
 *
 * The chart for tokens the embedded one cannot draw.
 *
 * TradingView is on the token page too, via DEX Screener, and it is the better
 * chart wherever it works. It does not work for the first few minutes of a
 * token's life, because the pair has not been indexed yet — and those minutes
 * are what this site is most about. This one is fed by the launch feed's own
 * trade stream and a backfill of the token's first transactions, so it draws
 * from the first trade onward.
 *
 * It is also the chart the product's claims are about: the prices here come
 * from the same reserves the fill engine quotes against, so a chart and a fill
 * can never disagree. That is worth keeping reachable even once the embed
 * lights up.
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
  h4: '4h',
  h12: '12h',
  d1: '1d',
  w1: '1w',
  mo1: '1M',
};

/** Moving averages, in candles. The two most-watched lengths. */
const SMA_PERIODS = [9, 21, 50] as const;
const EMA_PERIODS = [9, 21] as const;
const SMA_COLOURS: Record<number, string> = { 9: '#f0b429', 21: '#5b8def', 50: '#a855f7' };
const EMA_COLOURS: Record<number, string> = { 9: '#22d3ee', 21: '#f472b6' };
const BB_EDGE = 'rgba(91,141,239,0.65)';
const BB_MID = 'rgba(148,163,184,0.55)';
const VWAP_COLOUR = '#e0b0ff';

/** The indicators, in the order they appear in the rail. */
const INDICATORS: readonly { id: string; label: string }[] = [
  { id: 'sma', label: 'SMA' },
  { id: 'ema', label: 'EMA' },
  { id: 'bollinger', label: 'BB' },
  { id: 'vwap', label: 'VWAP' },
  { id: 'volume', label: 'VOL' },
  { id: 'rsi', label: 'RSI' },
  { id: 'macd', label: 'MACD' },
];

export function PriceChart({
  mint,
  timeframe = 'm1',
  timeframes,
  onTimeframe,
  onHistory,
  unit = 'market-cap',
  onUnit,
  height = 560,
}: {
  mint: string;
  timeframe?: string;
  /** The timeframes the left rail offers. Omitted, the rail hides them. */
  timeframes?: readonly string[];
  onTimeframe?: (timeframe: string) => void;
  /**
   * What the loaded history looks like: how many candles, over what span.
   *
   * Reported so the page can choose a bucket size that suits this token rather
   * than a fixed one. See token-view: a quiet token at fifteen-second candles
   * fills well under one percent of its slots and draws as scattered dashes.
   */
  onHistory?: (info: { candles: number; spanSeconds: number; backfilling: boolean }) => void;
  unit?: PriceUnit;
  onUnit?: (unit: PriceUnit) => void;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  /** Overlay line series on the price pane, keyed by their indicator line. */
  const overlays = useRef(new Map<string, ISeriesApi<'Line'>>());
  /** The RSI line, on its own pane, when RSI is on. */
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null);
  /** The MACD line, signal, and histogram, on their own pane, when MACD is on. */
  const macdRef = useRef<{
    line: ISeriesApi<'Line'>;
    signal: ISeriesApi<'Line'>;
    hist: ISeriesApi<'Histogram'>;
  } | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);
  /*
   * Whether a chart has ever drawn for this mint/timeframe. Held in a ref, not
   * read from `data`: the poll interval closes over the `data` from the render
   * that created it, which is null forever, so a `!data` check there reports a
   * transient failure over a chart that is already on screen. This is written
   * as the fetches resolve and reset when the token or timeframe changes.
   */
  const hasData = useRef(false);

  const [data, setData] = useState<CandleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(['sma', 'volume']));
  const toggle = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [drawing, setDrawing] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  /*
   * Whether the live price stream has dropped. The candle poll still refreshes
   * every few seconds, but the in-progress bar stops moving when the stream is
   * down, and a frozen "live" price a trader might act on should say so.
   */
  const [livePaused, setLivePaused] = useState(false);
  /*
   * Read by the chart's click handler, registered once when the chart is
   * created. Written in an effect rather than during render: a ref mutated in
   * the render body is a side effect in a function React may run twice or
   * discard.
   */
  const drawingRef = useRef(drawing);
  useEffect(() => {
    drawingRef.current = drawing;
  }, [drawing]);

  /**
   * SOL in dollars, for the market-cap axis.
   *
   * Null until it is known, and null forever if the rate cannot be read — in
   * which case the axis stays in SOL and the header says so. Printing a dollar
   * sign over a SOL figure is how a coin worth eight thousand dollars came to
   * read as "102".
   */
  const [solUsd, setSolUsd] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void fetch('/api/sol-price')
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { solUsd?: number } | null) => {
          if (!cancelled && typeof body?.solUsd === 'number') setSolUsd(body.solUsd);
        })
        .catch(() => undefined);
    };
    read();
    // The rate moves slowly; the chart does not need to know quickly.
    const timer = setInterval(read, 120_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // A new token or timeframe has not drawn yet, so re-arm the "first failure
    // reports" behaviour rather than inheriting the last chart's success.
    hasData.current = false;

    const read = (): void => {
      void fetch(`/api/candles?mint=${encodeURIComponent(mint)}&timeframe=${timeframe}`)
        .then(async (response) => {
          const body = (await response.json()) as CandleResponse | { error: string };
          if (cancelled) return;
          if ('error' in body) {
            setError(body.error);
            return;
          }
          // A response with neither an error nor candles is a broken one — a
          // proxy page during a redeploy, a truncated body — not an empty chart.
          // Reading its `candles.length` used to throw and take the render down.
          if (!Array.isArray(body.candles)) {
            if (!hasData.current) setError('Could not load the chart.');
            return;
          }
          setError(null);
          hasData.current = true;
          setData(body);

          const first = body.candles[0];
          const last = body.candles[body.candles.length - 1];
          // Count buckets that actually traded, not the flat fills stitched in
          // between them. The fill makes the series continuous but says nothing
          // about how busy the token is, and the page sizes its buckets from
          // how busy it is — counting the fills would read a quiet token as a
          // frantic one and pick a timeframe too fine to draw.
          onHistory?.({
            candles: body.candles.filter((candle) => candle.trades > 0).length,
            spanSeconds: first && last ? last.time - first.time : 0,
            backfilling: body.backfilling ?? false,
          });
        })
        .catch(() => {
          // Only the first failure is worth reporting. A dropped poll on a
          // chart that is already drawn should not replace it with an error.
          if (!cancelled && !hasData.current) setError('Could not load the chart.');
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

  /*
   * The live price, pushed rather than polled.
   *
   * Candles are still fetched on a timer because history is a bounded thing
   * worth asking for. The current price is not: it changes when somebody
   * trades, so asking on a timer means being wrong for the length of the timer.
   * The chain pushes it instead, and the bar being drawn is updated in place.
   *
   * Held in refs so a new price does not tear down the connection that
   * delivered it — the socket depends on the mint and nothing else.
   */
  const lastBar = useRef<CandlestickData | null>(null);
  const liveRef = useRef({ unit, solUsd, decimals: 0, supply: '0' });
  useEffect(() => {
    liveRef.current = {
      unit,
      solUsd,
      decimals: data?.tokenDecimals ?? 0,
      supply: data?.totalSupply ?? '0',
    };
  }, [unit, solUsd, data]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    setLivePaused(false);
    const source = new EventSource(`/api/price-stream?mint=${encodeURIComponent(mint)}`);

    // A dropped stream leaves the live bar frozen at its last value. The browser
    // retries on its own, so this only marks the price as paused and clears it
    // the moment anything arrives again, rather than tearing anything down.
    source.onopen = () => setLivePaused(false);
    source.onerror = () => setLivePaused(true);

    source.addEventListener('price', (event) => {
      setLivePaused(false);
      const bar = series.current;
      const latest = lastBar.current;
      if (!bar || !latest) return;

      let payload: { price?: string };
      try {
        payload = JSON.parse((event as MessageEvent).data) as { price?: string };
      } catch {
        return;
      }
      if (!payload.price) return;

      const { unit: u, solUsd: rate, decimals, supply } = liveRef.current;
      if (supply === '0') return;
      const value = toDisplay(payload.price, u, decimals, supply, rate);
      if (!Number.isFinite(value) || value <= 0) return;

      // The bar in progress moves; the ones behind it are history and do not.
      const updated: CandlestickData = {
        ...latest,
        close: value,
        high: Math.max(latest.high, value),
        low: Math.min(latest.low, value),
      };
      lastBar.current = updated;
      try {
        bar.update(updated);
      } catch {
        // A bar older than the series' last one is refused by the library;
        // the next candle poll will resynchronise it.
      }
    });

    return () => source.close();
  }, [mint]);

  const points = useMemo<CandlestickData[]>(() => {
    if (!data) return [];
    return data.candles.map((candle) => ({
      time: candle.time as UTCTimestamp,
      open: toDisplay(candle.open, unit, data.tokenDecimals, data.totalSupply, solUsd),
      high: toDisplay(candle.high, unit, data.tokenDecimals, data.totalSupply, solUsd),
      low: toDisplay(candle.low, unit, data.tokenDecimals, data.totalSupply, solUsd),
      close: toDisplay(candle.close, unit, data.tokenDecimals, data.totalSupply, solUsd),
    }));
    // solUsd matters: the axis is in dollars once it arrives, and without it
    // here the chart keeps drawing the SOL figures it first computed.
  }, [data, unit, solUsd]);

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

  // The candles reduced to what every indicator reads, in display units so an
  // indicator sits on the same axis as the price it is drawn over.
  const bars = useMemo<Bar[]>(
    () =>
      points.map((point, index) => ({
        time: point.time as number,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: volumes[index]?.value ?? 0,
      })),
    [points, volumes],
  );

  /** Feed every indicator series that currently exists its latest values. */
  const applyIndicators = useCallback(() => {
    const line = (input: readonly { time: number; value: number }[]) =>
      input.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));

    for (const period of SMA_PERIODS) overlays.current.get(`sma${period}`)?.setData(line(sma(bars, period)));
    for (const period of EMA_PERIODS) overlays.current.get(`ema${period}`)?.setData(line(ema(bars, period)));
    if (overlays.current.has('bbU')) {
      const band = bollinger(bars, 20, 2);
      overlays.current.get('bbU')?.setData(line(band.upper));
      overlays.current.get('bbM')?.setData(line(band.middle));
      overlays.current.get('bbL')?.setData(line(band.lower));
    }
    overlays.current.get('vwap')?.setData(line(vwap(bars)));

    rsiRef.current?.setData(line(rsi(bars, 14)));

    if (macdRef.current) {
      const value = macd(bars, 12, 26, 9);
      macdRef.current.line.setData(line(value.macd));
      macdRef.current.signal.setData(line(value.signal));
      macdRef.current.hist.setData(
        value.histogram.map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.value,
          color: p.value >= 0 ? 'rgba(63,224,138,0.5)' : 'rgba(255,95,86,0.5)',
        })),
      );
    }
  }, [bars]);

  // Build exactly the indicator series the enabled set asks for, and no others.
  // Rebuilt whole on a toggle rather than reconciled piece by piece: the set is
  // tiny, toggles are rare, and a clean rebuild cannot leave a stray pane or
  // series behind the way incremental add-and-remove can.
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;

    for (const line of overlays.current.values()) instance.removeSeries(line);
    overlays.current.clear();
    if (rsiRef.current) {
      instance.removeSeries(rsiRef.current);
      rsiRef.current = null;
    }
    if (macdRef.current) {
      instance.removeSeries(macdRef.current.line);
      instance.removeSeries(macdRef.current.signal);
      instance.removeSeries(macdRef.current.hist);
      macdRef.current = null;
    }
    try {
      while (instance.panes().length > 1) instance.removePane(instance.panes().length - 1);
    } catch {
      // Panes the library already collapsed with their series; nothing to do.
    }

    const addOverlay = (key: string, color: string, width = 1): void => {
      overlays.current.set(
        key,
        instance.addSeries(LineSeries, {
          color,
          lineWidth: width as 1 | 2,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        }),
      );
    };

    if (enabled.has('sma')) for (const period of SMA_PERIODS) addOverlay(`sma${period}`, SMA_COLOURS[period]!);
    if (enabled.has('ema')) for (const period of EMA_PERIODS) addOverlay(`ema${period}`, EMA_COLOURS[period]!);
    if (enabled.has('bollinger')) {
      addOverlay('bbU', BB_EDGE);
      addOverlay('bbM', BB_MID);
      addOverlay('bbL', BB_EDGE);
    }
    if (enabled.has('vwap')) addOverlay('vwap', VWAP_COLOUR, 2);

    let pane = 1;
    if (enabled.has('rsi')) {
      rsiRef.current = instance.addSeries(
        LineSeries,
        { color: '#e0b0ff', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false },
        pane,
      );
      instance.panes()[pane]?.setStretchFactor(1);
      pane += 1;
    }
    if (enabled.has('macd')) {
      const hist = instance.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
      const macdLine = instance.addSeries(
        LineSeries,
        { color: '#5b8def', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false },
        pane,
      );
      const signal = instance.addSeries(
        LineSeries,
        { color: '#f0b429', lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false },
        pane,
      );
      macdRef.current = { line: macdLine, signal, hist };
      instance.panes()[pane]?.setStretchFactor(1);
      pane += 1;
    }

    volume.current?.setData(enabled.has('volume') ? volumes : []);
    applyIndicators();
  }, [enabled, volumes, applyIndicators]);

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
      // Never let the axis fall below zero. A market cap cannot be negative, and
      // the library's default padding under a wide range pushed the scale into
      // negative numbers, which read as a broken chart. Clamp the low at zero
      // and keep the library's own high.
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        if (!info?.priceRange || info.priceRange.minValue >= 0) return info;
        return { ...info, priceRange: { ...info.priceRange, minValue: 0 } };
      },
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

    // The price pane keeps the lion's share of the height; the oscillator panes
    // that RSI and MACD add sit under it, each a fraction of the size.
    instance.panes()[0]?.setStretchFactor(4);

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
      overlays.current.clear();
      rsiRef.current = null;
      macdRef.current = null;
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
    lastBar.current = points[points.length - 1] ?? null;
    volume.current?.setData(enabled.has('volume') ? volumes : []);
    applyIndicators();

    // Only on the first draw. Refitting on every poll would yank the view back
    // to the whole range each time somebody zoomed in to look at something.
    if (!fitted.current) {
      const scale = chart.current?.timeScale();
      const width = container.current?.clientWidth ?? 0;
      // How many candles would fit at a sensible width. Fitting three of them
      // to a wide canvas draws three enormous blocks that read as a rendering
      // fault rather than as a token minutes old; pinning them to the right
      // instead leaves a wall of empty space where history would be.
      // Wide enough that candles are not tiny, tight enough that two of them
      // are not marooned at the left edge of an otherwise empty canvas — which
      // is the normal state of a token thirty seconds old.
      const comfortable = Math.min(Math.floor(width / 12), Math.max(points.length + 8, 40));

      if (points.length > 0 && points.length < comfortable) {
        // Data from the left, room to the right. The chart is filling forward,
        // and that is what it should look like.
        scale?.setVisibleLogicalRange({ from: -0.5, to: comfortable });
      } else {
        scale?.fitContent();
      }
      fitted.current = true;
    }
  }, [points, volumes, enabled, applyIndicators]);

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
          {unit === 'market-cap'
            ? solUsd
              ? 'market cap usd'
              : 'market cap sol'
            : 'price'}
          <span className="caret" />
        </span>

        {change !== null && (
          <span className={change >= 0 ? 'gain mono chart-change' : 'loss mono chart-change'}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(2)}%
          </span>
        )}

        {/* Honest about a chart that is not all there yet. Reading a token's past
            off a public RPC is slow, so a freshly opened token shows the few
            candles the live feed has caught while the history walks in behind
            it. Without this, those few candles read as the whole story. */}
        {data?.backfilling && (
          <span className="chart-loading mono dim" role="status">
            reading history<span className="caret" />
          </span>
        )}

        {/* The live price stream is down, so the in-progress bar is frozen.
            Said plainly, because a stale "live" price is one a trader might act
            on. Not shown while history is still loading, which is its own state. */}
        {livePaused && !data?.backfilling && (
          <span className="chart-loading mono loss" role="status">
            live paused
          </span>
        )}
      </div>

      <div className="chart-body">
        <div className="chart-rail">
          {timeframes && timeframes.length > 0 && (
            <div role="group" aria-label="Timeframe" className="rail-group">
              {timeframes.map((frame) => (
                <button
                  key={frame}
                  type="button"
                  className={frame === timeframe ? 'rail-btn on' : 'rail-btn'}
                  aria-pressed={frame === timeframe}
                  onClick={() => onTimeframe?.(frame)}
                >
                  {TIMEFRAME_LABELS[frame] ?? frame}
                </button>
              ))}
            </div>
          )}

          {onUnit && (
            <div role="group" aria-label="Unit" className="rail-group">
              <button
                type="button"
                className={unit === 'market-cap' ? 'rail-btn on' : 'rail-btn'}
                aria-pressed={unit === 'market-cap'}
                onClick={() => onUnit('market-cap')}
              >
                MCAP
              </button>
              <button
                type="button"
                className={unit === 'per-token' ? 'rail-btn on' : 'rail-btn'}
                aria-pressed={unit === 'per-token'}
                onClick={() => onUnit('per-token')}
              >
                PRICE
              </button>
            </div>
          )}

          <div role="group" aria-label="Indicators" className="rail-group">
            {INDICATORS.map((indicator) => (
              <button
                key={indicator.id}
                type="button"
                className={enabled.has(indicator.id) ? 'rail-btn on' : 'rail-btn'}
                aria-pressed={enabled.has(indicator.id)}
                onClick={() => toggle(indicator.id)}
              >
                {indicator.label}
              </button>
            ))}
          </div>

          <div role="group" aria-label="Drawing" className="rail-group">
            <button
              type="button"
              className={drawing ? 'rail-btn on' : 'rail-btn'}
              onClick={() => setDrawing((was) => !was)}
              aria-pressed={drawing}
              title="Click the chart to mark a price level"
            >
              LEVEL
            </button>
            {lineCount > 0 && (
              <button type="button" className="rail-btn" onClick={clearLines}>
                CLR {lineCount}
              </button>
            )}
          </div>
        </div>

        <div
          className={drawing ? 'chart-canvas drawing' : 'chart-canvas'}
          style={{ height }}
        >
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
      </div>

      {drawing && (
        <p className="dim chart-hint">Click anywhere on the chart to mark a price level.</p>
      )}
    </div>
  );
}
