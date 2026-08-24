'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ShareCard, type TradeCardData } from './share-card';
import { useWallet } from './wallet';

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
/*
 * The phone's three, which are not the desktop's five.
 *
 * A wide panel can carry a ladder from a tenth of a SOL to five and a keyboard
 * shortcut on each rung. A phone gets three buttons big enough to hit without
 * looking, and these are the three every mobile client puts there, so they are
 * the sizes somebody arriving already expects to see.
 */
const PHONE_BUY_PRESETS = [0.1, 0.2, 0.3];
/** The phone's sell sizes, as whole percentages of the position. */
const PHONE_SELL_PERCENTS = [25, 50, 100];
/** Where this browser's edited sizes live. */
const SIZES_KEY = 'probatio.trade.sizes';
/** Sell sizes, as a fraction of the position. */
/**
 * A whole percentage of a holding, or null if it is not one.
 *
 * Capped at 100 because there is no such thing as selling more of a position
 * than exists; the engine would reject it, but a button that offers something
 * impossible and then refuses it is worse than one that never offers it.
 * Floored at 1, since zero percent of anything is not a trade.
 */
function clampPercent(raw: string): number | null {
  const value = Math.floor(Number(raw));
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(100, value);
}

/**
 * The mark on the button that opens a custom amount.
 *
 * Drawn rather than set as a glyph or an emoji, so it takes the colour of the
 * button it sits in and renders the same everywhere.
 */
function PencilMark() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    </svg>
  );
}

const SELL_PRESETS: { label: string; numerator: number; denominator: number }[] = [
  { label: '25%', numerator: 1, denominator: 4 },
  { label: '50%', numerator: 1, denominator: 2 },
  { label: '100%', numerator: 1, denominator: 1 },
];

interface Filled {
  status: 'filled';
  tradeId: number;
  /** Which way it went, so the receipt can name its own rows. */
  side: 'buy' | 'sell';
  expected: { solAmount: string; tokenAmount: string };
  filled: {
    solAmount: string;
    tokenAmount: string;
    feeLamports: string;
    priceImpactBps: number;
    partial: boolean;
  };
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

function solFromLamports(lamports: string, places = 4): string {
  const value = Number(BigInt(lamports)) / Number(LAMPORTS_PER_SOL);
  return value.toFixed(places);
}

function toLamports(sol: number): string {
  return String(BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL))));
}

/** pump.fun tokens carry six decimals, so amounts arrive as base units. */
const TOKEN_DECIMALS = 6;

/**
 * Large token counts are unreadable at full precision.
 *
 * The input is base units and must be scaled down by the six decimals first, the
 * same as the positions table. Without that every quantity in this panel read a
 * million times too large: a holding of three tokens showed as "3.00M", and the
 * table right below it disagreed with the panel above.
 */
function tokens(baseUnits: string): string {
  const whole = Number(BigInt(baseUnits)) / 10 ** TOKEN_DECIMALS;
  if (whole >= 1_000_000_000) return `${(whole / 1_000_000_000).toFixed(2)}B`;
  if (whole >= 1_000_000) return `${(whole / 1_000_000).toFixed(2)}M`;
  if (whole >= 1_000) return `${(whole / 1_000).toFixed(2)}K`;
  if (whole >= 1) return whole.toFixed(2);
  // Below one token, show enough not to read as zero.
  return whole.toFixed(4);
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
  raced: 'Another of your trades landed first. Nothing changed, so try again.',
};

export function TradePanel({
  mint,
  onTraded,
}: {
  mint: string;
  /** Called after a fill so the positions beside this can refresh. */
  onTraded?: () => void;
}) {
  const { status, pubkey, signIn } = useWallet();
  const signedIn = status === 'signed-in' && pubkey !== null;

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  /*
   * One field, two units, so it is cleared when the side changes.
   *
   * Buying reads the field as SOL and selling reads it as a token count, which
   * are not remotely the same size. Carrying a number across meant choosing a
   * two SOL buy and then switching to sell offered to sell two tokens, and the
   * button said "sell 2.00" beside a holding of two million. A figure that
   * means something entirely different from what was typed should not survive
   * the change.
   */
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(1_000);
  const [showSlippage, setShowSlippage] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);
  /*
   * The receipt for the round trip that just closed, once it has been asked
   * for. Not fetched with the fill: most fills do not close anything, and a
   * request nobody asked for on every trade is a request for nothing.
   */
  const [receipt, setReceipt] = useState<TradeCardData | null>(null);
  const [fetchingReceipt, setFetchingReceipt] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [held, setHeld] = useState<string>('0');
  /** What the holding cost and what it is worth now, for the live position. */
  const [position, setPosition] = useState<{ costBasis: string; value: string | null } | null>(null);
  /*
   * The price as it moves, so the position figure moves with it.
   *
   * The value came from the positions endpoint, which reads every holding from
   * chain and so cannot be asked more than a few times a minute. On a token
   * that halves inside a minute, a figure a dozen seconds old is not a slow
   * number, it is the wrong one. The same stream the chart draws from pushes a
   * price whenever one trades, and a holding's worth is that price times what
   * is held, which is arithmetic this already has everything for.
   */
  const [livePrice, setLivePrice] = useState<string | null>(null);
  useEffect(() => {
    setLivePrice(null);
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/price-stream?mint=${encodeURIComponent(mint)}`);
    // `addEventListener`, not `onmessage`. The stream names its events, and
    // `onmessage` only ever receives the unnamed kind, so this listened to a
    // working connection and heard nothing: the holding's worth fell back to the
    // positions poll for the life of the page and the live price it describes
    // was permanently null.
    source.addEventListener('price', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data as string) as { price?: string };
        if (payload.price) setLivePrice(payload.price);
      } catch {
        // A malformed frame is one tick missed, not a reason to drop the stream.
      }
    });
    // Errors are left to the browser, which reconnects on its own.
    return () => source.close();
  }, [mint]);
  /** Scopes the hotkeys: see the keydown handler below. */
  const panel = useRef<HTMLElement>(null);

  // What this trader has, right now. Without it the sell side cannot know
  // whether there is anything to sell, and the buy side cannot say what is
  // affordable — both of which used to only appear after the first trade.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;

    const read = (): void => {
      void fetch('/api/positions', { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) {
            // Left alone rather than zeroed: a read that failed says nothing
            // about the holding, and showing "none" for it is a claim the
            // server never made.
            console.error('[trade] positions read failed', response.status, await response.text().catch(() => ''));
            return null;
          }
          return response.json();
        })
        .then(
          (
            data: {
              balance?: string;
              positions?: {
                mint: string;
                tokenAmount: string;
                costBasis: string;
                value: string | null;
              }[];
            } | null,
          ) => {
            if (cancelled || !data) return;
            if (data.balance) setBalance(data.balance);
            const open = data.positions?.find((entry) => entry.mint === mint);
            setHeld(open?.tokenAmount ?? '0');
            setPosition(
              open ? { costBasis: open.costBasis, value: open.value } : null,
            );
          },
        )
        .catch(() => undefined);
    };

    read();
    // Marked to the market while it is held, so the figure moves with the price
    // rather than only when a trade is made.
    const timer = setInterval(read, 12_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [signedIn, mint, result]);

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
        setReceipt(null);
        if (body.status === 'filled') {
          setBalance(body.balance);
          setHeld(body.position.tokenAmount);
          onTraded?.();
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
    [mint, onTraded, signedIn, slippageBps, working],
  );

  /*
   * A size button fills the field. It does not trade.
   *
   * It used to send the order on the single click that chose the size, so
   * picking an amount and placing an order were the same gesture and there was
   * no moment in between to change your mind or check the number. Anybody who
   * expected the ordinary two-step of choosing a size and then confirming had
   * already traded by the time they looked for the confirm button. Choosing is
   * separate from committing now; the button below commits.
   */
  /** Switch sides, dropping a figure that no longer means anything. */
  const chooseSide = useCallback((next: 'buy' | 'sell') => {
    setSide((current) => {
      if (current !== next) setAmount('');
      return next;
    });
  }, []);

  /*
   * The phone's custom amount, for the value that is not one of the three.
   *
   * The three buttons cover the common case and nothing else, which is fine
   * until somebody wants 1.33 SOL or to sell 27% of a position. The field
   * above accepts either, but on a phone it is a number pad and a token count
   * that runs off the end of the input, so reaching it to sell "most of this"
   * meant typing out nine figures of base units. This is the same action as a
   * preset: it fills the amount, it does not trade.
   */
  /*
   * Which of the three buttons is being retyped, and what into.
   *
   * The first version of this opened a separate field with its own Set button
   * underneath the row, which is a second way to do what the amount field above
   * already does. What was wanted is the buttons themselves: tap the pencil,
   * tap the size you want to replace, and type over it in place. So editing is
   * a state the row is in, and the index of the button currently holding an
   * input.
   */
  const [editing, setEditing] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  /*
   * The sizes on the buttons, which are a preference of this browser's.
   *
   * Kept here rather than in the database: they belong to the person holding
   * the phone, not to the account, and nothing about them is worth surviving
   * being wrong.
   */
  const [buySizes, setBuySizes] = useState<number[]>(PHONE_BUY_PRESETS);
  const [sellPercents, setSellPercents] = useState<number[]>(PHONE_SELL_PERCENTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIZES_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { buy?: number[]; sell?: number[] };
      if (Array.isArray(saved.buy) && saved.buy.length === 3) setBuySizes(saved.buy);
      if (Array.isArray(saved.sell) && saved.sell.length === 3) setSellPercents(saved.sell);
    } catch {
      // A corrupt preference is not worth a broken panel. The defaults stand.
    }
  }, []);

  const remember = useCallback((buy: number[], sell: number[]) => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify({ buy, sell }));
    } catch {
      // Private browsing, a full quota. The sizes still work for this session.
    }
  }, []);

  /*
   * Write a retyped size back onto its button.
   *
   * Nothing is applied to the amount field here: editing a size is changing a
   * tool, not placing an order, and a tap that both rewrites a button and fills
   * a trade is one tap doing two jobs. A value that does not parse leaves the
   * button as it was.
   */
  const commitSize = useCallback(
    (index: number) => {
      if (side === 'buy') {
        const sol = Number(draft);
        if (Number.isFinite(sol) && sol > 0) {
          const next = buySizes.map((value, at) => (at === index ? sol : value));
          setBuySizes(next);
          remember(next, sellPercents);
        }
      } else {
        const percent = clampPercent(draft);
        if (percent !== null) {
          const next = sellPercents.map((value, at) => (at === index ? percent : value));
          setSellPercents(next);
          remember(buySizes, next);
        }
      }
      setEditIndex(null);
      setDraft('');
    },
    [side, draft, buySizes, sellPercents, remember],
  );

  const buyPreset = useCallback((sol: number) => {
    setSide('buy');
    setAmount(String(sol));
  }, []);

  // Percent on one side and SOL on the other, so an edit carried across would
  // be applied to the wrong kind of number entirely.
  useEffect(() => {
    setEditing(false);
    setEditIndex(null);
    setDraft('');
  }, [side]);

  const sellFraction = useCallback(
    (numerator: number, denominator: number) => {
      const holding = BigInt(held);
      if (holding === 0n) return;
      const value =
        numerator === denominator ? holding : (holding * BigInt(numerator)) / BigInt(denominator);
      if (value <= 0n) return;
      setSide('sell');
      // The field is a token count, so the base units come back to whole tokens.
      setAmount((Number(value) / 10 ** TOKEN_DECIMALS).toString());
    },
    [held],
  );

  const submit = useCallback(() => {
    const typed = Number(amount);
    if (!Number.isFinite(typed) || typed <= 0) return;
    if (side === 'buy') void send(toLamports(typed), 'buy');
    // The field is a token count, and the engine wants base units. Scaling by
    // the decimals was missing, so a trader who typed 100 to sell a hundred
    // tokens sold a hundred base units, one ten-thousandth of a token.
    else void send(String(BigInt(Math.floor(typed * 10 ** TOKEN_DECIMALS))), 'sell');
  }, [amount, send, side]);

  // Hotkeys. Digits buy a preset, Q/W/E sell a fraction — close enough to the
  // muscle memory of the terminals people already use.
  useEffect(() => {
    if (!signedIn) return;

    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke from something being typed into.
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      /*
       * Only when nothing else has the keyboard.
       *
       * These fire a real trade with no confirmation, and they used to fire
       * from anywhere on the page. Two presses of Tab put focus on the
       * wordmark in the header; a digit after that bought a tenth of a SOL.
       * Anyone moving through the page by keyboard was one keystroke from
       * spending money they had not decided to spend.
       *
       * So they work where a trader actually is — nothing focused, or focus
       * already inside the trading surface — and stay out of the way while
       * somebody is navigating. The muscle memory is intact for the case it
       * was built for: watching the chart, hand on the number row.
       */
      const active = document.activeElement;
      const idle = !active || active === document.body;
      const inPanel = active instanceof Node && panel.current?.contains(active);
      if (!idle && !inPanel) return;

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
  }, [buyPreset, sellFraction, signedIn]);

  if (!signedIn) {
    return (
      <section className="term trade" aria-label="Trade">
        <div className="term-bar">
          <span className="prompt">~/trade</span>
          <span>locked</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <p className="dim">
            Connect a wallet to trade. It signs a message to prove the record is yours. Nothing
            is ever asked to move real funds.
          </p>
          <button type="button" className="button-link" onClick={() => void signIn()}>
            Connect Phantom
          </button>
        </div>
      </section>
    );
  }

  const holding = BigInt(held);

  return (
    <section className="term trade" aria-label="Trade" ref={panel}>
      <div className="term-bar">
        <span className="prompt">~/trade</span>
        <span>paper money</span>
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="term-body">
        {/*
          The position, marked to the market.
          
          What a holding cost and what it is worth now, side by side, with the
          difference in both SOL and percent. Without it the only way to know
          whether a trade was working was to read a fill receipt and do the
          arithmetic, and a receipt reports one trade rather than a position.
        */}
        {holding > 0n && position && (position.value !== null || livePrice !== null) && (
          (() => {
            const cost = Number(BigInt(position.costBasis)) / Number(LAMPORTS_PER_SOL);
            /*
             * Priced from the stream if it has spoken, and from the last read
             * otherwise. The scale is the one every stored price uses, so this
             * is the same multiplication the server would have done.
             */
            const marked =
              livePrice !== null
                ? (holding * BigInt(livePrice)) / 10n ** 18n
                : BigInt(position.value!);
            const now = Number(marked) / Number(LAMPORTS_PER_SOL);
            const change = now - cost;
            const percent = cost > 0 ? (change / cost) * 100 : 0;
            const up = change >= 0;
            return (
              <div className={up ? 'position up' : 'position down'}>
                <div className="position-legs">
                  <span>
                    <em>Cost</em>
                    <b className="mono">{cost.toFixed(4)}</b>
                  </span>
                  <span className="position-arrow" aria-hidden="true" />
                  <span>
                    <em>Now</em>
                    <b className="mono">{now.toFixed(4)}</b>
                  </span>
                </div>
                <div className="position-pnl mono">
                  <span className="position-pct">
                    {up ? '+' : ''}
                    {percent.toFixed(2)}%
                  </span>
                  <span className="position-abs">
                    {up ? '+' : ''}
                    {change.toFixed(4)} SOL
                  </span>
                </div>
              </div>
            );
          })()
        )}

        <div className="sides" role="group" aria-label="Side">
          <button
            type="button"
            className={side === 'buy' ? 'side buy on' : 'side buy'}
            onClick={() => chooseSide('buy')}
            aria-pressed={side === 'buy'}
          >
            Buy
          </button>
          <button
            type="button"
            className={side === 'sell' ? 'side sell on' : 'side sell'}
            onClick={() => chooseSide('sell')}
            aria-pressed={side === 'sell'}
          >
            Sell
          </button>
        </div>

        <div className="holdings">
          <span>
            <span className="k">Cash</span>
            <span className="mono">{balance === null ? '…' : `${solFromLamports(balance, 3)} SOL`}</span>
          </span>
          <span>
            <span className="k">Holding</span>
            <span className="mono">{holding === 0n ? 'none' : tokens(held)}</span>
          </span>
        </div>

        <label className="field">
          <span>{side === 'buy' ? 'Amount in SOL' : 'Tokens to sell'}</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={side === 'buy' ? 0.1 : 1}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            placeholder={side === 'buy' ? '0.00' : '0'}
          />
        </label>

        {side === 'buy' ? (
          <>
          <div className="presets" role="group" aria-label="Buy size">
            {BUY_PRESETS.map((sol, index) => (
              <button
                key={sol}
                type="button"
                className="preset"
                disabled={working}
                onClick={() => buyPreset(sol)}
              >
                {sol} <kbd>{index + 1}</kbd>
              </button>
            ))}
          </div>
          {/* The same action at a size a thumb can use. Only one of these two
              rows is ever displayed; which one is a question of whether there
              is a pointer, not of how wide the window is. */}
          <div
            className={editing ? 'presets phone-presets editing' : 'presets phone-presets'}
            role="group"
            aria-label="Buy size"
          >
            {buySizes.map((sol, index) =>
              editing && editIndex === index ? (
                <span key={index} className="preset buy-big as-field">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    autoFocus
                    value={draft}
                    aria-label="Buy size in SOL"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitSize(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitSize(index);
                      if (event.key === 'Escape') {
                        setEditIndex(null);
                        setDraft('');
                      }
                    }}
                  />
                </span>
              ) : (
                <button
                  key={index}
                  type="button"
                  className="preset buy-big"
                  disabled={working}
                  onClick={() => {
                    if (!editing) {
                      buyPreset(sol);
                      return;
                    }
                    setEditIndex(index);
                    setDraft(String(sol));
                  }}
                >
                  {sol}
                </button>
              ),
            )}
            {/* Turns the three into fields you can type over. */}
            <button
              type="button"
              className={editing ? 'preset custom-toggle on' : 'preset custom-toggle'}
              aria-pressed={editing}
              aria-label={editing ? 'Done editing sizes' : 'Edit sizes'}
              disabled={working}
              onClick={() => {
                setEditing((was) => !was);
                setEditIndex(null);
                setDraft('');
              }}
            >
              <PencilMark />
            </button>
          </div>
          </>
        ) : (
          <>
          <div className="presets" role="group" aria-label="Sell size">
            {SELL_PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                type="button"
                className="preset"
                disabled={working || holding === 0n}
                onClick={() => sellFraction(preset.numerator, preset.denominator)}
              >
                {preset.label} <kbd>{['Q', 'W', 'E'][index]}</kbd>
              </button>
            ))}
          </div>
          {/*
            The same three on a phone, which had none of them.
            
            The rule that hides the desktop buy ladder on a phone was written as
            `.presets:not(.phone-presets)`, which is every preset row including
            this one, so selling on a phone meant typing a token count of nine
            or ten figures into a field narrower than the number. A percentage
            of what you hold is the only sane way to size a sell.
          */}
          <div
            className={editing ? 'presets phone-presets editing' : 'presets phone-presets'}
            role="group"
            aria-label="Sell size"
          >
            {sellPercents.map((percent, index) =>
              editing && editIndex === index ? (
                // The % stays put. It is what the number means, not part of it.
                <span key={index} className="preset sell-big as-field">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    step={1}
                    autoFocus
                    value={draft}
                    aria-label="Sell size, percent of holding"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitSize(index)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitSize(index);
                      if (event.key === 'Escape') {
                        setEditIndex(null);
                        setDraft('');
                      }
                    }}
                  />
                  <i aria-hidden="true">%</i>
                </span>
              ) : (
                <button
                  key={index}
                  type="button"
                  className="preset sell-big"
                  disabled={working || (holding === 0n && !editing)}
                  onClick={() => {
                    if (!editing) {
                      sellFraction(percent, 100);
                      return;
                    }
                    setEditIndex(index);
                    setDraft(String(percent));
                  }}
                >
                  {percent}%
                </button>
              ),
            )}
            <button
              type="button"
              className={editing ? 'preset custom-toggle on' : 'preset custom-toggle'}
              aria-pressed={editing}
              aria-label={editing ? 'Done editing sizes' : 'Edit sizes'}
              disabled={working}
              onClick={() => {
                setEditing((was) => !was);
                setEditIndex(null);
                setDraft('');
              }}
            >
              <PencilMark />
            </button>
          </div>
          </>
        )}

        <button
          type="button"
          className={side === 'buy' ? 'execute buy' : 'execute sell'}
          disabled={working || !amount || Number(amount) <= 0}
          onClick={submit}
        >
          {working
            ? 'In flight…'
            : side === 'buy'
              ? `Buy${amount ? ` ${amount} SOL` : ''}`
              : `Sell${amount ? ` ${tokens(String(Math.floor((Number(amount) || 0) * 10 ** TOKEN_DECIMALS)))}` : ''}`}
        </button>

        <button
          type="button"
          className="ghost-link toggle"
          onClick={() => setShowSlippage((was) => !was)}
          aria-expanded={showSlippage}
        >
          Slippage {(slippageBps / 100).toFixed(1)}%
        </button>

        {showSlippage && (
          /*
           * Typed as a percentage, which is the unit it is spoken in.
           *
           * It took basis points, so somebody who wanted ten percent had to
           * know to type a thousand, and somebody who typed ten got a tenth of
           * a percent and had every trade rejected without being told why. The
           * engine still works in basis points; only the field has changed, and
           * one decimal place is as fine as the engine can act on anyway.
           */
          <label className="field">
            <span>Tolerance, in percent</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={slippageBps / 100}
              onChange={(event) => {
                const percent = Number(event.target.value);
                if (!Number.isFinite(percent)) return;
                // Clamped here rather than trusted from the field, because a
                // browser will hand over whatever was typed regardless of min
                // and max, and a negative tolerance rejects everything.
                const clamped = Math.min(100, Math.max(0, percent));
                setSlippageBps(Math.round(clamped * 100));
              }}
            />
          </label>
        )}

        {working && (
          <p aria-live="polite" className="inflight">
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            The fill lands after the network delay, against the market as it is by then.
          </p>
        )}

        {result?.status === 'rejected' && (
          <p role="alert" className="rejected">
            {REJECTION_TEXT[result.reason] ?? result.detail}
            {/* A rejection is a real outcome here, not a bug. Real trades revert. */}
          </p>
        )}

        {result?.status === 'filled' && (
          <div aria-live="polite" className="fill">
            <div className="fill-head">
              <span className="cmd">
                filled
                <span className="caret" />
              </span>
              {result.filled.partial && <span className="pill">partial</span>}
            </div>

            {/*
              Named for the direction traded.
              
              Both sides used to read "Size / Quoted / Got", where size was
              always the SOL leg and quoted and got were always the token leg.
              On a sell that meant the SOL you received was labelled as the size
              you sent and the tokens you sold were labelled as what you got,
              which reads as a loss on a winning trade and is how a sell at a
              higher price came out looking wrong.
            */}
            <dl className="fill-rows">
              <dt>{result.side === 'sell' ? 'Sold' : 'Spent'}</dt>
              <dd className="mono">
                {result.side === 'sell'
                  ? tokens(result.filled.tokenAmount)
                  : `${solFromLamports(result.filled.solAmount)} SOL`}
              </dd>

              <dt>{result.side === 'sell' ? 'Received' : 'Got'}</dt>
              <dd className="mono">
                {result.side === 'sell'
                  ? `${solFromLamports(result.filled.solAmount)} SOL`
                  : tokens(result.filled.tokenAmount)}
              </dd>

              <dt>Quoted</dt>
              <dd className="mono">
                {result.side === 'sell'
                  ? `${solFromLamports(result.expected.solAmount)} SOL`
                  : tokens(result.expected.tokenAmount)}
              </dd>

              <dt>Fee</dt>
              <dd className="mono">{solFromLamports(result.filled.feeLamports)} SOL</dd>

              <dt>Impact</dt>
              <dd className="mono">{result.filled.priceImpactBps}bp</dd>
            </dl>

            {/*
              A round trip has just ended, which is the one moment somebody
              wants to post about it.
              
              Only on a sell that left nothing behind. A buy is half a story and
              a partial sell is a story still going, and offering a receipt for
              either would produce a card describing a trade that has not
              finished happening.
            */}
            {result.side === 'sell' && result.position.tokenAmount === '0' && (
              <p className="fill-receipt">
                {receipt ? null : (
                  <button
                    type="button"
                    className="linklike"
                    disabled={fetchingReceipt}
                    onClick={() => {
                      setFetchingReceipt(true);
                      void fetch('/api/card')
                        .then(async (response) => {
                          if (!response.ok) return;
                          const body = (await response.json()) as { trades: TradeCardData[] };
                          /*
                           * The newest closed trip, which is the one that just
                           * closed. Read back rather than assembled from the
                           * fill, so the figures on the card come from the same
                           * replay the profile does and cannot drift from it.
                           */
                          setReceipt(body.trades[0] ?? null);
                        })
                        .finally(() => setFetchingReceipt(false));
                    }}
                  >
                    {fetchingReceipt ? 'getting the receipt' : 'get the receipt'}
                  </button>
                )}
              </p>
            )}

            {receipt && <ShareCard trade={receipt} onClose={() => setReceipt(null)} />}

            {/* The number the whole product turns on. */}
            <p
              className={
                result.slippageBps > 0 ? 'slip loss' : result.slippageBps < 0 ? 'slip gain' : 'slip dim'
              }
            >
              {result.slippageBps > 0
                ? `The price moved ${result.slippageBps}bp against you in the ${result.latencyMs}ms it took to land.`
                : result.slippageBps < 0
                  ? `The price moved ${-result.slippageBps}bp your way while you waited.`
                  : `No movement in the ${result.latencyMs}ms it took to land.`}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
