'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Positions, equity and the trade log.
 *
 * The figure that matters most is total return, because that is what a season
 * is ranked on. It is shown against the starting balance rather than against
 * cash, so a trader holding a winner reads as ahead of one holding nothing,
 * which they are, even before they sell.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

interface PositionEntry {
  mint: string;
  tokenAmount: string;
  costBasis: string;
  realizedPnl: string;
  value: string | null;
  unrealized: string | null;
  price: string | null;
}

interface Snapshot {
  balance: string;
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
  positions: PositionEntry[];
}

interface TradeEntry {
  id: number;
  mint: string;
  side: 'buy' | 'sell';
  solAmount: string;
  tokenAmount: string;
  fee: string;
  priceImpactBps: number;
  partial: boolean;
  latencyMs: number;
  leafHash: string;
  /** Whether a confirmed batch on chain covers this trade. */
  committed?: boolean;
  createdAt: number;
}

function sol(lamports: string): string {
  return (Number(BigInt(lamports)) / LAMPORTS_PER_SOL).toFixed(4);
}

/** Signed SOL, so a loss reads as a loss rather than as a smaller number. */
function signedSol(lamports: string): string {
  const value = BigInt(lamports);
  const formatted = (Number(value < 0n ? -value : value) / LAMPORTS_PER_SOL).toFixed(4);
  return value < 0n ? `-${formatted}` : `+${formatted}`;
}

function short(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * A token amount a person can read.
 *
 * The log used to print raw base units, so a holding of three and a half tokens
 * read as "3743047", a number that means nothing without knowing the token has
 * six decimal places. pump.fun mints all use six, so the base units are divided
 * back to whole tokens and then abbreviated, because a memecoin balance is
 * routinely in the millions and a full integer string is just as unreadable in
 * the other direction.
 */
const TOKEN_DECIMALS = 6;

function tokens(baseUnits: string): string {
  const whole = Number(BigInt(baseUnits)) / 10 ** TOKEN_DECIMALS;
  if (whole >= 1_000_000_000) return `${(whole / 1_000_000_000).toFixed(2)}B`;
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(2)}K`;
  if (whole >= 1) return whole.toFixed(2);
  // Below one token, show enough to not read as zero.
  return whole.toFixed(4);
}

/**
 * Price impact as a percentage, which is the number people trade on.
 *
 * "17bp" is basis points, and nobody reading their own trade history thinks in
 * basis points. Seventeen of them is 0.17%, which is what pump.fun and every
 * other front end shows.
 */
function slippage(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function Positions({ refreshKey = 0 }: { refreshKey?: number }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [trades, setTrades] = useState<TradeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [positionsResponse, tradesResponse] = await Promise.all([
        fetch('/api/positions'),
        // More history now that the log scrolls in place: it was held to
        // twenty-five because every extra row made the page taller.
        fetch('/api/trades?limit=100'),
      ]);

      const positionsBody = (await positionsResponse.json()) as Snapshot | { error: string };
      if ('error' in positionsBody) {
        setError(positionsBody.error);
        return;
      }
      setSnapshot(positionsBody);
      setError(null);

      const tradesBody = (await tradesResponse.json()) as { trades: TradeEntry[] } | { error: string };
      if (!('error' in tradesBody)) setTrades(tradesBody.trades);
    } catch {
      setError('Could not load your positions.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error) return <p role="alert">{error}</p>;
  if (!snapshot) return <p>Loading…</p>;

  return (
    <section aria-label="Positions">
      <h2>Open positions</h2>
      {snapshot.positions.length === 0 ? (
        <p>Nothing open.</p>
      ) : (
        <div className="scroller">
        <table>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Held</th>
              <th scope="col">Cost</th>
              <th scope="col">Value</th>
              <th scope="col">Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.positions.map((position) => (
              <tr key={position.mint}>
                <td data-label="Token">
                  <a href={`/t/${position.mint}`}>{short(position.mint)}</a>
                </td>
                <td data-label="Held">{tokens(position.tokenAmount)}</td>
                <td data-label="Cost">{sol(position.costBasis)}</td>
                <td data-label="Value">
                  {/* A price that could not be read is said so, not shown as
                      zero, because a failed RPC call must never look like a wipeout. */}
                  {position.value === null ? 'price unavailable' : `${sol(position.value)} SOL`}
                </td>
                <td data-label="Unrealized">
                  {position.unrealized === null ? '·' : `${signedSol(position.unrealized)} SOL`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <h2>Trades</h2>
      {trades.length === 0 ? (
        <p>No trades yet.</p>
      ) : (
        <>
        <p className="dim" style={{ fontSize: 13 }}>
          Every fill you have made, at the price the market was at that moment. Slippage is how
          far the price moved against you between clicking and landing.
        </p>
        <div className="scroller trade-log">
        <table>
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col">Token</th>
              <th scope="col">SOL</th>
              <th scope="col">Tokens</th>
              <th scope="col">Fee</th>
              {/* Slippage, in the percent people trade on rather than the basis
                  points the engine works in. */}
              <th scope="col">Slippage</th>
              {/*
                No column for whether this reached the chain.
                
                It read "recording…" on every row of every trade, because the
                program those commits call is not deployed and nothing is being
                written. A status that has only ever had one value is not a
                status, and one that says a thing is in progress when nothing is
                happening is worse than absent. The hash each trade was sealed
                with is still on the row, as its title.
              */}
            </tr>
          </thead>
          <tbody>
            {/*
              Every cell carries the name of its own column.

              Six columns do not fit a phone. They were left to a sideways
              scroll inside a rounded box, which clipped "side" at the left edge
              and hid three of the six until you dragged. On a narrow screen CSS
              turns each row into a small block instead, and a value with no
              heading above it is unreadable, so each one brings its heading
              with it.
            */}
            {trades.map((trade) => (
              <tr key={trade.id}>
                <td data-label="Side" className={trade.side === 'buy' ? 'gain' : 'loss'}>
                  {trade.side}
                </td>
                <td data-label="Token">
                  <a href={`/t/${trade.mint}`}>{short(trade.mint)}</a>
                </td>
                <td data-label="SOL">{sol(trade.solAmount)}</td>
                <td data-label="Tokens">{tokens(trade.tokenAmount)}</td>
                <td data-label="Fee">{sol(trade.fee)}</td>
                <td data-label="Slippage" title={`sealed as ${trade.leafHash}`}>
                  {slippage(trade.priceImpactBps)}
                  {trade.partial && ' · partial'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        </>
      )}
    </section>
  );
}
