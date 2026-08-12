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

function percent(bps: number): string {
  const value = bps / 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
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
        fetch('/api/trades?limit=25'),
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

  const { equity } = snapshot;

  const down = equity.returnBps < 0;

  return (
    <section aria-label="Positions">
      {/* The same clean readout the public record uses, so signed in and public
          read as one thing. Total return leads because it is the number a
          season is ranked on. */}
      <div className="panel">
        <div className="panel-head">
          <h2>Account</h2>
        </div>
        <div className="readout">
          <div className="readout-row">
            <span className="k">Total return</span>
            <span className={`v ${down ? 'loss' : 'gain'}`}>
              {percent(equity.returnBps)} ({signedSol(equity.totalPnl)} SOL)
            </span>
          </div>
          <div className="readout-row">
            <span className="k">Equity</span>
            <span className="v">{sol(equity.equity)} SOL</span>
          </div>
          <div className="readout-row">
            <span className="k">Cash</span>
            <span className="v">{sol(equity.cash)} SOL</span>
          </div>
          <div className="readout-row">
            <span className="k">In positions</span>
            <span className="v">{sol(equity.positionValue)} SOL</span>
          </div>
          <div className="readout-row">
            <span className="k">Realized</span>
            <span className="v">{signedSol(equity.realized)} SOL</span>
          </div>
          <div className="readout-row">
            <span className="k">Unrealized</span>
            <span className="v">{signedSol(equity.unrealized)} SOL</span>
          </div>
        </div>
      </div>

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
                <td>
                  <a href={`/t/${position.mint}`}>{short(position.mint)}</a>
                </td>
                <td>{tokens(position.tokenAmount)}</td>
                <td>{sol(position.costBasis)}</td>
                <td>
                  {/* A price that could not be read is said so, not shown as
                      zero, because a failed RPC call must never look like a wipeout. */}
                  {position.value === null ? 'price unavailable' : `${sol(position.value)} SOL`}
                </td>
                <td>{position.unrealized === null ? '·' : `${signedSol(position.unrealized)} SOL`}</td>
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
          Every fill you have made. Slippage is how far the price moved against you on the way in.
          Record shows whether the trade has been written to Solana yet, which is what makes it
          checkable by anyone.
        </p>
        <div className="scroller">
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
              {/* One column, not two. "Leaf hash" beside "on chain" was a raw
                  hash a normal reader has no use for and a status they do. The
                  hash is what a verifier needs, so it is kept on the row as a
                  hover title rather than taking a column of its own. */}
              <th scope="col">Record</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr key={trade.id}>
                <td className={trade.side === 'buy' ? 'gain' : 'loss'}>{trade.side}</td>
                <td>
                  <a href={`/t/${trade.mint}`}>{short(trade.mint)}</a>
                </td>
                <td>{sol(trade.solAmount)}</td>
                <td>{tokens(trade.tokenAmount)}</td>
                <td>{sol(trade.fee)}</td>
                <td>
                  {slippage(trade.priceImpactBps)}
                  {trade.partial && ' · partial'}
                </td>
                <td
                  className={trade.committed ? 'gain' : 'dim'}
                  title={`proof ${trade.leafHash}`}
                >
                  {trade.committed ? 'on chain' : 'recording…'}
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
