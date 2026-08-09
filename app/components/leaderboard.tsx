'use client';

import { useEffect, useState } from 'react';

/**
 * The standings.
 *
 * Live standings move with the market, which is said out loud rather than left
 * to be discovered: a trader who refreshes and drops a place should know it was
 * the market and not a recount.
 */

interface Row {
  rank: number;
  trader: string;
  returnBps: number;
  tradeCount: number;
  payoutLamports: string;
}

interface Board {
  season: { ordinal: number; name: string; status: string; entrants: number } | null;
  standings: Row[];
  you: Row | null;
  total: number;
  final: boolean;
}

function percent(bps: number): string {
  const sign = bps > 0 ? '+' : '';
  return `${sign}${(bps / 100).toFixed(1)}%`;
}

function short(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

function sol(lamports: string): string {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = ((value % 1_000_000_000n) * 100n) / 1_000_000_000n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

function Standing({ row, you = false }: { row: Row; you?: boolean }) {
  return (
    <tr aria-current={you ? 'true' : undefined}>
      <td>{row.rank}</td>
      <td>{you ? 'You' : short(row.trader)}</td>
      <td>{percent(row.returnBps)}</td>
      <td>{row.tradeCount}</td>
      <td>{row.payoutLamports === '0' ? '' : `${sol(row.payoutLamports)} SOL`}</td>
    </tr>
  );
}

export function Leaderboard() {
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/leaderboard')
      .then((response) => response.json() as Promise<Board>)
      .then((body) => {
        if (!cancelled) setBoard(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // No ranked season is a normal state. Free play is the product.
  if (!board?.season) return null;

  return (
    <section aria-label="Leaderboard">
      <h2>Standings</h2>

      {board.standings.length === 0 ? (
        <p>Nobody has entered yet. First in is first on the board.</p>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Trader</th>
                <th scope="col">Return</th>
                <th scope="col">Trades</th>
                <th scope="col">Pays</th>
              </tr>
            </thead>
            <tbody>
              {board.standings.map((row) => (
                <Standing key={row.trader} row={row} you={row.trader === board.you?.trader} />
              ))}
              {board.you && <Standing row={board.you} you />}
            </tbody>
          </table>

          <p>
            {board.final
              ? 'Final.'
              : 'Live. Open positions are marked at the current price, so these move with the market.'}
          </p>
        </>
      )}
    </section>
  );
}
