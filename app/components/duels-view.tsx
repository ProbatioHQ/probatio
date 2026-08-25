'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Head to head duels.
 *
 * A duel is a window two traders agreed to, scored off the accounts they already
 * entered the season with. Nothing on this screen places an order: the trading
 * is the ordinary trading both of them were doing anyway, on the same board, and
 * the duel is a second way of reading it.
 *
 * The screen is arranged around whichever of the three states a person is
 * actually in. Somebody with a live duel wants two numbers and a clock and
 * nothing else; somebody with an offer waiting wants to answer it; everybody
 * else wants the form. Showing all three at once would bury the one that matters
 * under the two that do not.
 */

interface Side {
  pubkey: string;
  name: string;
  bps: number | null;
}

interface Duel {
  id: number;
  status: 'offered' | 'live' | 'settled' | 'declined' | 'withdrawn' | 'expired';
  windowSeconds: number;
  createdAt: number;
  offerExpiresAt: number;
  startedAt: number | null;
  endsAt: number | null;
  settledAt: number | null;
  challenger: Side;
  opponent: Side;
  you: Side | null;
  them: Side | null;
  iChallenged: boolean | null;
  winner: string | null;
  fullyPriced: boolean;
  seal: string | null;
}

interface Loaded {
  signedIn: boolean;
  canOffer: boolean;
  why?: string | null;
  windows: number[];
  mine: Duel[];
  running?: { you: number; them: number } | null;
  record: { won: number; lost: number; drawn: number } | null;
  recent: Duel[];
}

const POLL_MS = 6_000;

function windowLabel(seconds: number): string {
  const label = (count: number, unit: string): string =>
    `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (seconds % 86_400 === 0) return label(seconds / 86_400, 'day');
  if (seconds % 3_600 === 0) return label(seconds / 3_600, 'hour');
  return label(Math.round(seconds / 60), 'minute');
}

/** A signed percentage, with the sign spelled rather than typed. */
function pct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  const value = bps / 100;
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`;
}

/**
 * The colour a figure is drawn in.
 *
 * A figure nobody could read is neither. Painted green it would say the duel is
 * level and fine, which is a claim about the market rather than an admission
 * that the market could not be reached.
 */
/**
 * The size class for the pair of figures, chosen by the longer of the two.
 *
 * A duel is exactly where a four-figure return turns up: somebody who caught a
 * launch is at +1240.00%, nine characters where +8.76% is six. Half a phone
 * screen fits the short one comfortably and the long one not at all, and a
 * viewport clamp cannot tell them apart because it can only see the viewport.
 *
 * Sized off the pair rather than each on its own, which matters more than it
 * sounds: set separately, the long figure came out smaller than the short one,
 * their baselines stopped lining up, and the layout ended up saying the smaller
 * number was the lesser one. These are two halves of the same claim and they
 * are typeset as a pair.
 */
function sizeOf(a: string, b: string): string {
  return Math.max(a.length, b.length) > 8 ? 'duel-bps long' : 'duel-bps';
}

function tone(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return 'dim';
  return bps >= 0 ? 'gain' : 'loss';
}

function countdown(to: number, now: number): string {
  const left = Math.max(0, Math.floor((to - now) / 1_000));
  const hours = Math.floor(left / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);
  const seconds = left % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function DuelsView() {
  const [data, setData] = useState<Loaded | null>(null);
  const [opponent, setOpponent] = useState('');
  const [windowSeconds, setWindowSeconds] = useState(3_600);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  const pull = useCallback(async () => {
    try {
      const response = await fetch('/api/duel', { cache: 'no-store' });
      if (!response.ok) return;
      const next = (await response.json()) as Loaded;
      if (alive.current) setData(next);
    } catch {
      // A failed poll keeps the last view rather than clearing it. The clock
      // below keeps running off the last known end, which is still true.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void pull();
    const id = setInterval(() => void pull(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [pull]);

  /*
   * The clock ticks locally rather than waiting for the next poll.
   *
   * A countdown that only moved every six seconds reads as broken, and the
   * remaining time is a function of a timestamp already in hand.
   */
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const act = useCallback(
    async (id: number, action: 'accept' | 'decline' | 'withdraw') => {
      setBusy(true);
      setNote(null);
      try {
        const response = await fetch('/api/duel', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, action }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) setNote(body.error ?? 'that did not work');
        await pull();
      } finally {
        setBusy(false);
      }
    },
    [pull],
  );

  const offer = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch('/api/duel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ opponent, windowSeconds }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNote(body.error ?? 'that did not work');
      } else {
        setOpponent('');
        setNote('offered. They have thirty minutes to answer.');
      }
      await pull();
    } finally {
      setBusy(false);
    }
  }, [opponent, windowSeconds, pull]);

  if (!data) return <p className="dim">Reading duels.</p>;

  const live = data.mine.find((duel) => duel.status === 'live') ?? null;
  const incoming = data.mine.filter(
    (duel) => duel.status === 'offered' && duel.iChallenged === false && duel.offerExpiresAt > now,
  );
  const outgoing = data.mine.filter(
    (duel) => duel.status === 'offered' && duel.iChallenged === true && duel.offerExpiresAt > now,
  );
  const past = data.mine.filter((duel) => duel.status === 'settled');

  /*
   * A record worth showing, or none at all.
   *
   * It used to render `0W 0L 0D` for everybody who had never duelled, which at
   * pill size reads as three letters rather than three counts and says nothing
   * either way. Somebody with no record has no record; the absence is the
   * honest rendering of it.
   *
   * Spelled out rather than abbreviated for the same reason. "1 won, 2 lost" is
   * read correctly the first time; "1W 2L" is a thing you have to decode, and
   * it is decoded wrongly when one of the numbers is a nought.
   */
  const record = ((): string | null => {
    if (!data.record) return null;
    const { won, lost, drawn } = data.record;
    if (won + lost + drawn === 0) return null;
    const parts = [`${won} won`, `${lost} lost`];
    if (drawn > 0) parts.push(`${drawn} drawn`);
    return parts.join(', ');
  })();

  const scale = sizeOf(pct(data.running?.you), pct(data.running?.them));

  return (
    <div className="duels">
      {live && live.you && live.them ? (
        <section className="panel duel-live">
          <div className="panel-head">
            <h2>Live duel</h2>
            <span className="pill live">
              {live.endsAt === null ? 'running' : `${countdown(live.endsAt, now)} left`}
            </span>
          </div>
          <div className="duel-score">
            <div className="duel-side">
              <div className="duel-who">{live.you.name}</div>
              <div className={`${scale} ${tone(data.running?.you)}`}>
                {pct(data.running?.you)}
              </div>
              <div className="duel-tag">you</div>
            </div>
            <div className="duel-rule" />
            <div className="duel-side">
              <div className="duel-who">{live.them.name}</div>
              <div className={`${scale} ${tone(data.running?.them)}`}>
                {pct(data.running?.them)}
              </div>
              <div className="duel-tag">them</div>
            </div>
          </div>
          <p className="dim duel-note">
            Both figures are your whole account, marked now, against what it was worth when the duel
            started. Trade as you normally would. Nothing here places an order and nothing you do in
            a duel is scored differently on the leaderboard.
          </p>
        </section>
      ) : null}

      {incoming.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Challenged</h2>
          </div>
          <ul className="duel-list">
            {incoming.map((duel) => (
              <li key={duel.id}>
                <span className="duel-line">
                  <b>{duel.challenger.name}</b> wants {windowLabel(duel.windowSeconds)} against you.
                  Expires in {countdown(duel.offerExpiresAt, now)}.
                </span>
                <span className="duel-acts">
                  <button
                    type="button"
                    className="linklike"
                    disabled={busy || live !== null}
                    onClick={() => void act(duel.id, 'accept')}
                  >
                    accept
                  </button>
                  <button
                    type="button"
                    className="linklike"
                    disabled={busy}
                    onClick={() => void act(duel.id, 'decline')}
                  >
                    decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {live !== null ? (
            <p className="dim">You are already in a duel, so these cannot be accepted yet.</p>
          ) : null}
        </section>
      ) : null}

      {live === null ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Challenge someone</h2>
            {record ? <span className="pill">{record}</span> : null}
          </div>
          {!data.canOffer ? (
            /*
             * Said, and left usable.
             *
             * This used to disable the boxes when the caller could not yet
             * offer, which meant somebody who had not entered the season could
             * not click into the field, could not pick a window, and had no way
             * to tell a locked form from a broken one. A form that refuses a
             * keystroke is indistinguishable from a form that is not working.
             *
             * The refusal belongs on the way out rather than on the way in. The
             * route already checks entry, the season and the pair, and answers
             * with a sentence; pressing the action shows that sentence. So the
             * form fills in for anybody, and the only thing that ever says no is
             * the thing that actually knows.
             */
            <p className="dim">
              {!data.signedIn
                ? 'Connect a wallet and enter the season to send this.'
                : (data.why ?? 'you cannot offer a duel right now')}
            </p>
          ) : null}
          <div className="duel-form">
            <label className="field">
              <span className="label">Their name or address</span>
              <input
                value={opponent}
                onChange={(event) => setOpponent(event.target.value)}
                placeholder="wagie"
                disabled={busy}
              />
            </label>
            <label className="field">
              <span className="label">Over</span>
              <select
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
                disabled={busy}
              >
                {data.windows.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {windowLabel(seconds)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="linklike"
              disabled={busy || opponent.trim() === ''}
              onClick={() => void offer()}
            >
              offer it
            </button>
          </div>
          {note ? <p className="dim">{note}</p> : null}
          <p className="dim duel-note">
            They have thirty minutes to answer. The clock starts when they accept, not when you
            offer, and both of your accounts are measured at that moment.
          </p>
        </section>
      ) : null}

      {outgoing.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Waiting on them</h2>
          </div>
          <ul className="duel-list">
            {outgoing.map((duel) => (
              <li key={duel.id}>
                <span className="duel-line">
                  <b>{duel.opponent.name}</b>, {windowLabel(duel.windowSeconds)}. Lapses in{' '}
                  {countdown(duel.offerExpiresAt, now)}.
                </span>
                <span className="duel-acts">
                  <button
                    type="button"
                    className="linklike"
                    disabled={busy}
                    onClick={() => void act(duel.id, 'withdraw')}
                  >
                    withdraw
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {past.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Your record</h2>
          </div>
          <ul className="duel-list">
            {past.map((duel) => (
              <li key={duel.id}>
                <span className="duel-line">
                  <b>{duel.them?.name ?? duel.opponent.name}</b> over{' '}
                  {windowLabel(duel.windowSeconds)}. {pct(duel.you?.bps)} against{' '}
                  {pct(duel.them?.bps)}.{' '}
                  {duel.winner === null
                    ? 'Drawn.'
                    : duel.winner === duel.you?.pubkey
                      ? 'Won.'
                      : 'Lost.'}
                  {duel.fullyPriced ? '' : ' A position could not be priced, so it was counted at cost.'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Recently settled</h2>
        </div>
        {data.recent.length === 0 ? (
          <p className="dim">Nobody has finished a duel yet.</p>
        ) : (
          <ul className="duel-list">
            {data.recent.map((duel) => (
              <li key={duel.id}>
                <span className="duel-line">
                  <b>{duel.challenger.name}</b> {pct(duel.challenger.bps)} against{' '}
                  <b>{duel.opponent.name}</b> {pct(duel.opponent.bps)} over{' '}
                  {windowLabel(duel.windowSeconds)}.{' '}
                  {duel.winner === null
                    ? 'Drawn.'
                    : `${duel.winner === duel.challenger.pubkey ? duel.challenger.name : duel.opponent.name} won.`}
                </span>
                {duel.seal ? <span className="duel-seal">{duel.seal.slice(0, 12)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
