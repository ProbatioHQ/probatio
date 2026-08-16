'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The account at a glance: where the equity stands, how it got there, and what
 * the trade log says about how it was traded.
 *
 * The curve is drawn on a canvas rather than as SVG on purpose — the same choice
 * the price chart makes — so it paints in every browser the price chart does.
 * Every figure is derived from the trade log by the stats endpoint; nothing here
 * is stored, so nothing here can disagree with the trades below it.
 */

const LAMPORTS = 1_000_000_000;

const solNum = (value: string | bigint): number => Number(BigInt(value)) / LAMPORTS;
const sol = (value: string | bigint, dp = 2): string => solNum(value).toFixed(dp);
const signedSol = (value: string | bigint, dp = 3): string => {
  const n = solNum(value);
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
};
const pct = (bps: number): string => `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`;
const pctPlain = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

function duration(ms: number): string {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const HOURS = ['12a', '', '2a', '', '4a', '', '6a', '', '8a', '', '10a', '', '12p', '', '2p', '', '4p', '', '6p', '', '8p', '', '10p', ''];

interface EquityPoint {
  at: number;
  equity: string;
}

interface Stats {
  trips: number;
  wins: number;
  losses: number;
  scratches: number;
  winRateBps: number;
  netPnl: string;
  grossProfit: string;
  grossLoss: string;
  feesPaid: string;
  expectancy: string | null;
  profitFactorBps: number | null;
  averageWin: string | null;
  averageLoss: string | null;
  largestWin: string | null;
  largestLoss: string | null;
  averageSize: string | null;
  holdMs: number;
  winnerHoldMs: number;
  loserHoldMs: number;
  maxDrawdown: string;
  maxDrawdownBps: number | null;
  longestLosingStreak: number;
  longestWinningStreak: number;
  equityCurve: EquityPoint[];
  bestHourUtc: number | null;
  worstHourUtc: number | null;
  hours: { hour: number; trips: number; realized: string; winRateBps: number }[];
  entryEfficiencyBps: number | null;
  exitEfficiencyBps: number | null;
  gaveBackWinners: number;
  excursionsScored: number;
  openPositions: number;
}

interface Snapshot {
  startingBalance: string;
  equity: {
    cash: string;
    positionValue: string;
    equity: string;
    realized: string;
    unrealized: string;
    totalPnl: string;
    returnBps: number;
  };
}

function EquityCanvas({ curve, starting, up }: { curve: EquityPoint[]; starting: number; up: boolean }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const wrap = canvas?.parentElement;
    if (!canvas || !wrap) return;

    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const values = curve.map((p) => solNum(p.equity));
      const times = curve.map((p) => p.at);
      const all = [...values, starting];
      let lo = Math.min(...all);
      let hi = Math.max(...all);
      if (hi === lo) {
        hi += 1;
        lo -= 1;
      }
      const padY = (hi - lo) * 0.12;
      lo -= padY;
      hi += padY;
      const t0 = times[0]!;
      const t1 = times[times.length - 1]!;
      const span = t1 - t0 || 1;

      const padL = 6;
      const padR = 6;
      const padT = 10;
      const padB = 10;
      const x = (t: number): number => padL + ((t - t0) / span) * (w - padL - padR);
      const y = (v: number): number => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

      const line = up ? '#3fe08a' : '#ff5f56';

      // Break-even baseline, at the starting balance.
      ctx.strokeStyle = 'rgba(153,160,171,0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y(starting));
      ctx.lineTo(w - padR, y(starting));
      ctx.stroke();
      ctx.setLineDash([]);

      // Area fill under the curve.
      const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
      grad.addColorStop(0, up ? 'rgba(63,224,138,0.22)' : 'rgba(255,95,86,0.22)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(x(times[0]!), h - padB);
      curve.forEach((p, i) => ctx.lineTo(x(times[i]!), y(values[i]!)));
      ctx.lineTo(x(t1), h - padB);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // The curve itself.
      ctx.beginPath();
      curve.forEach((p, i) => {
        const px = x(times[i]!);
        const py = y(values[i]!);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // The latest point, marked.
      const lx = x(t1);
      const ly = y(values[values.length - 1]!);
      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = line;
      ctx.fill();
      ctx.strokeStyle = 'rgba(5,6,7,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [curve, starting, up]);

  return <canvas ref={ref} className="acct-canvas" />;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'gain' | 'loss';
}): React.JSX.Element {
  return (
    <div className="acct-stat">
      <span className="acct-stat-k">{label}</span>
      <span className={`acct-stat-v${tone ? ` ${tone}` : ''}`}>{value}</span>
      {sub && <span className="acct-stat-sub">{sub}</span>}
    </div>
  );
}

export function AccountOverview(): React.JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch('/api/stats'), fetch('/api/positions')])
      .then(async ([s, p]) => {
        const statsBody = s.ok ? ((await s.json()) as Stats) : null;
        const snapBody = p.ok ? ((await p.json()) as Snapshot) : null;
        if (cancelled) return;
        if (!statsBody || !snapBody) {
          setError('Could not load your account right now.');
          return;
        }
        setStats(statsBody);
        setSnap(snapBody);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your account right now.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p role="alert" className="loss">{error}</p>;
  if (!stats || !snap) return <p className="dim acct-loading">Reading your trade log…</p>;

  const eq = snap.equity;
  const up = eq.returnBps >= 0;
  const starting = solNum(snap.startingBalance);
  const hasCurve = stats.equityCurve.length >= 2;
  const profitFactor =
    stats.profitFactorBps === null ? '∞' : (stats.profitFactorBps / 10000).toFixed(2);

  return (
    <section className="acct" aria-label="Account overview">
      <div className="acct-hero">
        <div className="acct-hero-top">
          <div className="acct-eq-block">
            <span className="acct-eq-label">Equity</span>
            <div className="acct-eq">
              {sol(eq.equity)}
              <span className="acct-eq-unit">SOL</span>
            </div>
            <span className="acct-eq-note dim">
              cash {sol(eq.cash)} · in positions {sol(eq.positionValue)}
            </span>
          </div>
          <div className={`acct-return ${up ? 'gain' : 'loss'}`}>
            <span className={`acct-arrow ${up ? 'up' : 'down'}`} aria-hidden="true" />
            <span className="acct-return-pct">{pct(eq.returnBps)}</span>
            <span className="acct-return-sub">{signedSol(eq.totalPnl)} SOL total</span>
          </div>
        </div>

        <div className="acct-curve">
          {hasCurve ? (
            <EquityCanvas curve={stats.equityCurve} starting={starting} up={up} />
          ) : (
            <div className="acct-curve-empty dim">
              Your equity curve is drawn once you have closed a couple of trades. Buy a token and
              sell it back, and the line starts here.
            </div>
          )}
        </div>

        <div className="acct-hero-foot">
          <span>
            <em className="dim">Realized</em>{' '}
            <b className={solNum(eq.realized) >= 0 ? 'gain' : 'loss'}>{signedSol(eq.realized)}</b>
          </span>
          <span>
            <em className="dim">Unrealized</em>{' '}
            <b className={solNum(eq.unrealized) >= 0 ? 'gain' : 'loss'}>
              {signedSol(eq.unrealized)}
            </b>
          </span>
          <span>
            <em className="dim">Fees paid</em> <b>{sol(stats.feesPaid, 3)}</b>
          </span>
          <span>
            <em className="dim">Open</em> <b>{stats.openPositions}</b>
          </span>
        </div>
      </div>

      {stats.trips === 0 ? (
        <p className="dim acct-none">
          No closed trades yet. Your win rate, streaks and the rest fill in as you trade — a trade
          counts once you have sold what you bought.
        </p>
      ) : (
        <>
          <div className="acct-grid">
            <Stat
              label="Win rate"
              value={pctPlain(stats.winRateBps)}
              sub={`${stats.wins}W · ${stats.losses}L · ${stats.scratches} flat`}
            />
            <Stat
              label="Profit factor"
              value={profitFactor}
              sub={stats.profitFactorBps === null ? 'no losses yet' : 'profit ÷ loss'}
              tone={stats.profitFactorBps !== null && stats.profitFactorBps >= 10000 ? 'gain' : undefined}
            />
            <Stat
              label="Expectancy"
              value={stats.expectancy === null ? '—' : `${signedSol(stats.expectancy)} SOL`}
              sub="average per trade"
              tone={stats.expectancy !== null ? (solNum(stats.expectancy) >= 0 ? 'gain' : 'loss') : undefined}
            />
            <Stat label="Closed trades" value={String(stats.trips)} sub={`avg hold ${duration(stats.holdMs)}`} />
            <Stat
              label="Average win"
              value={stats.averageWin === null ? '—' : `${signedSol(stats.averageWin)}`}
              sub={stats.largestWin === null ? undefined : `best ${signedSol(stats.largestWin)}`}
              tone="gain"
            />
            <Stat
              label="Average loss"
              value={stats.averageLoss === null ? '—' : `${signedSol(stats.averageLoss)}`}
              sub={stats.largestLoss === null ? undefined : `worst ${signedSol(stats.largestLoss)}`}
              tone="loss"
            />
            <Stat
              label="Max drawdown"
              value={stats.maxDrawdownBps === null ? '—' : `-${pctPlain(stats.maxDrawdownBps)}`}
              sub={`${sol(stats.maxDrawdown, 3)} SOL peak-to-trough`}
              tone={stats.maxDrawdownBps ? 'loss' : undefined}
            />
            <Stat
              label="Streaks"
              value={`${stats.longestWinningStreak}W · ${stats.longestLosingStreak}L`}
              sub="longest run"
            />
          </div>

          <details className="acct-adv">
            <summary>Advanced breakdown</summary>
            <div className="acct-adv-body">
              <div className="acct-adv-card">
                <h4>How you enter and exit</h4>
                <p className="dim">
                  Of the move a trade offered — its lowest to highest price while you held it —
                  how much you actually captured. Higher is better timing.
                </p>
                <div className="acct-adv-rows">
                  <span>
                    Entry timing{' '}
                    <b>{stats.entryEfficiencyBps === null ? '—' : pctPlain(stats.entryEfficiencyBps)}</b>
                  </span>
                  <span>
                    Exit timing{' '}
                    <b>{stats.exitEfficiencyBps === null ? '—' : pctPlain(stats.exitEfficiencyBps)}</b>
                  </span>
                  <span>
                    Winners given back <b>{stats.gaveBackWinners}</b>
                  </span>
                </div>
              </div>

              <div className="acct-adv-card">
                <h4>Holding time</h4>
                <p className="dim">
                  How long you sit in a trade. If winners are held far longer than losers, you are
                  letting them run; the reverse is cutting winners early.
                </p>
                <div className="acct-adv-rows">
                  <span>
                    Winners <b className="gain">{duration(stats.winnerHoldMs)}</b>
                  </span>
                  <span>
                    Losers <b className="loss">{duration(stats.loserHoldMs)}</b>
                  </span>
                  <span>
                    All trades <b>{duration(stats.holdMs)}</b>
                  </span>
                </div>
              </div>

              <div className="acct-adv-card">
                <h4>When you trade well</h4>
                <p className="dim">
                  Realized profit by hour of day (UTC), across your whole log. The bar is green in
                  the hours you have made money, red where you have lost it.
                </p>
                <div className="acct-hours" aria-hidden="true">
                  {stats.hours.map((bucket) => {
                    const r = solNum(bucket.realized);
                    const max = Math.max(
                      1,
                      ...stats.hours.map((b) => Math.abs(solNum(b.realized))),
                    );
                    const height = Math.round((Math.abs(r) / max) * 100);
                    return (
                      <span
                        key={bucket.hour}
                        className={`acct-hour ${r >= 0 ? 'gain' : 'loss'}`}
                        style={{ ['--h' as string]: `${Math.max(height, bucket.trips ? 6 : 0)}%` }}
                        title={`${bucket.hour}:00 UTC — ${signedSol(bucket.realized)} SOL over ${bucket.trips} trades`}
                      />
                    );
                  })}
                </div>
                <div className="acct-hours-axis dim" aria-hidden="true">
                  {HOURS.map((h, i) => (
                    <span key={i}>{h}</span>
                  ))}
                </div>
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
