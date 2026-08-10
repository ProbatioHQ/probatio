'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The TradingView chart, for real.
 *
 * TradingView's own widget cannot chart these tokens — it only knows symbols
 * listed on the exchanges it covers, and a pump.fun mint minutes old is on
 * none of them. What it can do is take custom data, and DEX Screener licenses
 * exactly that: their embed is TradingView's charting library fed with pump.fun
 * and PumpSwap trades. So this is not a lookalike. It is the same charting
 * engine, with the indicators, the drawing tools, and the timeframes people
 * already know, pointed at the token on the page.
 *
 * It is also somebody else's iframe, which is why it is not the only chart
 * here. Everything inside it comes from DEX Screener — their data, their
 * uptime, their view of the market. The native chart beside it is built from
 * the same reserves this site quotes fills against, and that is the one the
 * product's claims are about. Both, labelled, rather than one pretending to be
 * the other.
 */

const BASE = 'https://dexscreener.com/solana';

export function DexChart({ mint, height = 620 }: { mint: string; height?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  // A third party that never answers must not leave a spinner forever.
  useEffect(() => {
    if (loaded) return;
    const timer = setTimeout(() => setFailed(true), 20_000);
    return () => clearTimeout(timer);
  }, [loaded]);

  const source =
    `${BASE}/${encodeURIComponent(mint)}` +
    // embed strips their site furniture; trades and info panels are off
    // because this page has its own, and they would only disagree.
    '?embed=1&theme=dark&trades=0&info=0&interval=1&chartType=usd';

  return (
    <div className="dex-chart" style={{ height }}>
      {!loaded && !failed && (
        <p className="chart-empty dim">Loading the chart…</p>
      )}

      {failed && !loaded && (
        <p className="chart-empty dim">
          The chart could not be reached. It is served by DEX Screener, so this is their side
          rather than yours — the native chart below still works, and so does trading.
        </p>
      )}

      <iframe
        ref={frame}
        src={source}
        title="Price chart"
        loading="lazy"
        onLoad={() => setLoaded(true)}
        // Sandboxed. It needs scripts and its own origin to run the chart, and
        // nothing else — no forms, no popups, no top-level navigation, so an
        // embedded page cannot move the tab out from under a trader.
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ opacity: loaded ? 1 : 0 }}
      />
    </div>
  );
}
