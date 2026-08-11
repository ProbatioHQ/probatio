'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Positions, equity and the trade log.
 *
 * The figure that matters most is total return, because that is what a season
 * is ranked on. It is shown against the starting balance rather than against
 * cash, so a trader holding a winner reads as ahead of one holding nothing —
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

  return (
    <section aria-label="Positions">
      <h2>Account</h2>
      <dl>
        <dt>Equity</dt>
        <dd>{sol(equity.equity)} SOL</dd>

        <dt>Total return</dt>
        {/* The number a season is ranked on. */}
        <dd>
          {percent(equity.returnBps)} ({signedSol(equity.totalPnl)} SOL)
        </dd>

        <dt>Cash</dt>
        <dd>{sol(equity.cash)} SOL</dd>

        <dt>In positions</dt>
        <dd>{sol(equity.positionValue)} SOL</dd>

        <dt>Realized</dt>
        <dd>{signedSol(equity.realized)} SOL</dd>

        <dt>Unrealized</dt>
        <dd>{signedSol(equity.unrealized)} SOL</dd>
      </dl>

      <h2>Open positions</h2>
      {snapshot.positions.length === 0 ? (
        <p>Nothing open.</p>
      ) : (
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
                <td>{position.tokenAmount}</td>
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
      )}

      <h2>Trades</h2>
      {trades.length === 0 ? (
        <p>No trades yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col">Token</th>
              <th scope="col">SOL</th>
              <th scope="col">Tokens</th>
              <th scope="col">Fee</th>
              <th scope="col">Impact</th>
              {/* What it is, not what it proves. The hash exists from the
                  moment the trade fills; whether it is on chain is the next
                  column's job to say. */}
              <th scope="col">Leaf hash</th>
              <th scope="col">On chain</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => (
              <tr key={trade.id}>
                <td>{trade.side}</td>
                <td>{short(trade.mint)}</td>
                <td>{sol(trade.solAmount)}</td>
                <td>{trade.tokenAmount}</td>
                <td>{sol(trade.fee)}</td>
                <td>{trade.priceImpactBps}bp{trade.partial && ' · partial'}</td>
                {/* What a trader hands to the verifier to prove this happened. */}
                <td><code>{trade.leafHash.slice(0, 12)}…</code></td>
                <td className={trade.committed ? 'gain' : 'dim'}>
                  {trade.committed ? 'committed' : 'not yet'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
