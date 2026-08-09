'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The buy and sell panel.
 *
 * Its one job beyond taking an order is to show what the fill actually was
 * against what was quoted. Every other paper trading tool shows you the price
 * on screen and calls that your fill; the difference between those two numbers
 * is the entire product, so it is displayed rather than smoothed over.
 */

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Buy sizes, in SOL. The hotkeys are the digits beside them. */
const BUY_PRESETS = [0.1, 0.5, 1, 2, 5];
/** Sell sizes, as a fraction of the position. */
const SELL_PRESETS: { label: string; numerator: number; denominator: number }[] = [
  { label: '25%', numerator: 1, denominator: 4 },
  { label: '50%', numerator: 1, denominator: 2 },
  { label: '100%', numerator: 1, denominator: 1 },
];

interface Filled {
  status: 'filled';
  tradeId: number;
  expected: { solAmount: string; tokenAmount: string };
  filled: { solAmount: string; tokenAmount: string; feeLamports: string; priceImpactBps: number; partial: boolean };
  slippageBps: number;
  latencyMs: number;
  balance: string;
  position: { tokenAmount: string; costBasis: string; realizedPnl: string };
  realized: string;
}

interface Rejected {
  status: 'rejected';
  reason: string;
  detail: string;
}

type TradeResult = Filled | Rejected;

function solFromLamports(lamports: string): string {
  const value = Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL);
  return value.toFixed(4);
}

function toLamports(sol: number): string {
  return String(BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL))));
}

/** Plain language for a rejection. A trader should not have to read a code. */
const REJECTION_TEXT: Record<string, string> = {
  slippage: 'The price moved too far while your trade was in flight.',
  price_impact: 'That size would move the market further than the limit allows.',
  no_liquidity: 'There was nothing left to trade against.',
  dust: 'That size is too small to fill.',
  partial_not_allowed: 'Only part of that size could be filled.',
  venue_changed: 'The token graduated while your trade was in flight.',
  insufficient_sol: 'Not enough SOL.',
  insufficient_tokens: 'You do not hold that many tokens.',
};

export function TradePanel({
  mint,
  signedIn,
}: {
  mint: string;
  signedIn: boolean;
}) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [slippageBps, setSlippageBps] = useState(1_000);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [held, setHeld] = useState<string>('0');

  const send = useCallback(
    async (size: string, tradeSide: 'buy' | 'sell') => {
      if (!signedIn || working) return;
      setWorking(true);
      setResult(null);

      try {
        const response = await fetch('/api/trade', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mint, side: tradeSide, size, slippageBps }),
        });
        const body = (await response.json()) as TradeResult | { error: string };

        if ('error' in body) {
          setResult({ status: 'rejected', reason: 'error', detail: body.error });
          return;
        }

        setResult(body);
        if (body.status === 'filled') {
          setBalance(body.balance);
          setHeld(body.position.tokenAmount);
        }
      } catch {
        setResult({
          status: 'rejected',
          reason: 'error',
          detail: 'The trade could not be sent.',
        });
      } finally {
        setWorking(false);
      }
    },
    [mint, signedIn, slippageBps, working],
  );

  const buyPreset = useCallback(
    (sol: number) => void send(toLamports(sol), 'buy'),
    [send],
  );

  const sellFraction = useCallback(
    (numerator: number, denominator: number) => {
      const holding = BigInt(held);
      if (holding === 0n) return;
      const amount =
        numerator === denominator
          ? holding
          : (holding * BigInt(numerator)) / BigInt(denominator);
      if (amount > 0n) void send(String(amount), 'sell');
    },
    [held, send],
  );

  // Hotkeys. Digits buy a preset, Q/W/E sell a fraction — close enough to the
  // muscle memory of the terminals people already use.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke from something being typed into.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= BUY_PRESETS.length) {
        event.preventDefault();
        buyPreset(BUY_PRESETS[digit - 1]!);
        return;
      }

      const sellIndex = ['q', 'w', 'e'].indexOf(event.key.toLowerCase());
      if (sellIndex !== -1) {
        event.preventDefault();
        const preset = SELL_PRESETS[sellIndex]!;
        sellFraction(preset.numerator, preset.denominator);
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [buyPreset, sellFraction]);

  if (!signedIn) {
    return <p>Sign in with your wallet to trade.</p>;
  }

  return (
    <section aria-label="Trade">
      <div role="group" aria-label="Side">
        <button type="button" onClick={() => setSide('buy')} aria-pressed={side === 'buy'}>
          Buy
        </button>
        <button type="button" onClick={() => setSide('sell')} aria-pressed={side === 'sell'}>
          Sell
        </button>
      </div>

      {side === 'buy' ? (
        <div role="group" aria-label="Buy size">
          {BUY_PRESETS.map((sol, index) => (
            <button key={sol} type="button" disabled={working} onClick={() => buyPreset(sol)}>
              {sol} SOL <kbd>{index + 1}</kbd>
            </button>
          ))}
        </div>
      ) : (
        <div role="group" aria-label="Sell size">
          {SELL_PRESETS.map((preset, index) => (
            <button
              key={preset.label}
              type="button"
              disabled={working || held === '0'}
              onClick={() => sellFraction(preset.numerator, preset.denominator)}
            >
              {preset.label} <kbd>{['Q', 'W', 'E'][index]}</kbd>
            </button>
          ))}
        </div>
      )}

      <label>
        Slippage tolerance
        <input
          type="number"
          min={0}
          max={10_000}
          step={50}
          value={slippageBps}
          onChange={(event) => setSlippageBps(Number(event.target.value))}
        />
        bps
      </label>

      {balance !== null && <p>Balance {solFromLamports(balance)} SOL</p>}

      {working && <p aria-live="polite">Sending… the fill lands after the network delay.</p>}

      {result?.status === 'rejected' && (
        <p role="alert">
          {REJECTION_TEXT[result.reason] ?? result.detail}
          {/* A rejection is a real outcome here, not a bug. Real trades revert. */}
        </p>
      )}

      {result?.status === 'filled' && (
        <div aria-live="polite">
          <p>
            Filled {solFromLamports(result.filled.solAmount)} SOL
            {result.filled.partial && ' (partial)'}
          </p>
          <p>
            Quoted {result.expected.tokenAmount} tokens, got {result.filled.tokenAmount}.
          </p>
          <p>
            {/* The number the whole product turns on. */}
            {result.slippageBps > 0
              ? `The price moved ${result.slippageBps}bp against you in the ${result.latencyMs}ms it took to land.`
              : result.slippageBps < 0
                ? `The price moved ${-result.slippageBps}bp your way while you waited.`
                : `No movement in the ${result.latencyMs}ms it took to land.`}
          </p>
          <p>
            Fee {solFromLamports(result.filled.feeLamports)} SOL · impact{' '}
            {result.filled.priceImpactBps}bp
          </p>
        </div>
      )}
    </section>
  );
}
