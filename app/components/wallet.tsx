'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import bs58 from 'bs58';
import { PHANTOM_INSTALL_URL, getPhantom } from '@/lib/phantom';

/**
 * One wallet, shared by everything that needs it.
 *
 * Sign-in used to be a component that owned its own state, which meant two
 * copies of it on a page disagreed about whether anyone was signed in. It is a
 * property of the session, not of a button, so it lives in a context and the
 * buttons are views onto it.
 */

type Status = 'loading' | 'signed-out' | 'working' | 'signed-in';

interface WalletState {
  readonly status: Status;
  readonly pubkey: string | null;
  readonly error: string | null;
  /** Lamports, as they arrived with the session. Null until one is known. */
  readonly balance: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet outside WalletProvider');
  return value;
}

export function shortenPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/session', { cache: 'no-store' })
      .then(
        (response) =>
          response.json() as Promise<{ pubkey: string | null; balance?: string | null }>,
      )
      .then((data) => {
        if (cancelled) return;
        setPubkey(data.pubkey);
        if (data.balance) setBalance(data.balance);
        setStatus(data.pubkey ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        if (!cancelled) setStatus('signed-out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset to signed-out whenever the wallet changes or disconnects its active
  // account in the extension. The server session belongs to the key that signed
  // in, so if that key changes underneath us, keeping the old identity would let
  // a payment be signed by a wallet the session does not match. The cookie is
  // cleared too, so a stale session cannot act as the old wallet.
  useEffect(() => {
    const phantom = getPhantom();
    if (!phantom?.on) return;
    const reset = (): void => {
      void fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      setPubkey(null);
      setStatus('signed-out');
      setError(null);
    };
    phantom.on('accountChanged', reset);
    phantom.on('disconnect', reset);
    return () => {
      phantom.off?.('accountChanged', reset);
      phantom.off?.('disconnect', reset);
    };
  }, []);

  // Set synchronously at the top of signIn so two fast clicks in one frame,
  // before the disabled button re-renders, cannot fire two connect+sign flows.
  const signingIn = useRef(false);

  const signIn = useCallback(async () => {
    if (signingIn.current) return;
    const phantom = getPhantom();
    if (!phantom) {
      window.open(PHANTOM_INSTALL_URL, '_blank', 'noopener,noreferrer');
      return;
    }

    signingIn.current = true;
    setStatus('working');
    setError(null);
    try {
      const { publicKey } = await phantom.connect();
      const address = publicKey.toString();

      const challenge = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey: address }),
      });
      if (!challenge.ok) throw new Error(((await challenge.json()) as { error: string }).error);
      const { nonce, message } = (await challenge.json()) as { nonce: string; message: string };

      const { signature } = await phantom.signMessage(new TextEncoder().encode(message), 'utf8');

      const verified = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey: address, nonce, signature: bs58.encode(signature) }),
      });
      if (!verified.ok) throw new Error(((await verified.json()) as { error: string }).error);

      setPubkey(address);
      setStatus('signed-in');
    } catch (caught) {
      // Someone closing the wallet popup made a decision. It is not an error and
      // should not be shown to them as one. Phantom signals that with the
      // standard 4001 rejection code, checked before the message text so a
      // differently worded or localized message still reads as a quiet cancel.
      const code = (caught as { code?: number } | null)?.code;
      const message = caught instanceof Error ? caught.message : 'Sign-in failed.';
      const cancelled = code === 4001 || /user rejected|declined/i.test(message);
      setStatus('signed-out');
      setError(cancelled ? null : message);
    } finally {
      signingIn.current = false;
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setPubkey(null);
    setStatus('signed-out');
    setError(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({ status, pubkey, error, balance, signIn, signOut }),
    [status, pubkey, error, balance, signIn, signOut],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/**
 * A wallet address drawn as a mark.
 *
 * Four bars keyed off the address bytes. It is not an avatar and carries no
 * information the address does not, but it gives a signed-in trader something
 * to recognise at a glance that eight hex characters do not.
 */
function AddressMark({ pubkey }: { pubkey: string }) {
  const bars = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      out.push((pubkey.charCodeAt(i * 3) + pubkey.charCodeAt(i * 3 + 1)) % 100);
    }
    return out;
  }, [pubkey]);

  return (
    <span className="addr-mark" aria-hidden="true">
      {bars.map((height, index) => (
        <i key={index} style={{ height: `${30 + (height / 100) * 70}%` }} />
      ))}
    </span>
  );
}

/**
 * The wallet control in the header.
 *
 * Signed in, it shows the address and the live practice balance, because the
 * question a trader has on every page is how much they have left. The menu
 * behind it is where sign-out went — a destructive-ish action does not deserve
 * to sit permanently next to the buy buttons.
 */
export function WalletButton() {
  const { status, pubkey, signIn, signOut, balance: fromSession } = useWallet();
  const [open, setOpen] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  /*
   * Both balances, once they are known.
   *
   * A wallet entered in a ranked season is trading a separate account with its
   * own ten SOL, and free play keeps its own underneath. Showing one figure
   * meant the number in the header changed the moment somebody entered, with
   * nothing to say which of the two it had become.
   */
  const [split, setSplit] = useState<{
    free: { balance: string };
    ranked: { balance: string; ordinal: number; live: boolean } | null;
  } | null>(null);
  // Whatever is newest: the refresher once it has answered, otherwise the
  // figure that arrived with the session, so the pill has a number from the
  // first render rather than waiting on a second request.
  const balance = fresh ?? fromSession;
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'signed-in') {
      setFresh(null);
      return;
    }
    let cancelled = false;
    const read = (): void => {
      // The cash balance, not equity: it is what a buy spends and a sell
      // returns, so it moves exactly when the trader acts, which is the number
      // being checked. Equity (cash plus the value of what is held) barely
      // moves on a buy, since the spend becomes a holding, and that reads as
      // "it did not take my SOL". The holding's worth lives with the position
      // on the trade panel, where it belongs.
      //
      // From the one-row endpoint rather than the positions one, which prices
      // every holding from chain and shares the chain-read budget with trading.
      // `no-store`, because a balance answered once and then replayed from the
      // browser's cache is a stale number presented as a live one — and a 401
      // cached from before signing in would keep the pill empty for the whole
      // session, which is exactly how this looked.
      void fetch('/api/balance', { cache: 'no-store', credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) {
            // The body carries the reason. A status on its own says something
            // broke; the detail says what, which is the difference between
            // guessing at this and fixing it.
            const body = await response.text().catch(() => '');
            console.error('[wallet] balance read failed', response.status, body);
            return null;
          }
          return (await response.json()) as {
            balance?: string;
            free?: { balance: string };
            ranked?: { balance: string; ordinal: number; live: boolean } | null;
          };
        })
        .then((data) => {
          if (cancelled || !data) return;
          if (data.balance) setFresh(data.balance);
          if (data.free) setSplit({ free: data.free, ranked: data.ranked ?? null });
        })
        .catch((error) => console.error('[wallet] balance read failed', error));
    };
    read();
    // A first read that lands before the session cookie is in play would
    // otherwise leave the pill empty until the next tick.
    const retry = setTimeout(read, 1_500);
    // Refreshed on a timer so a fill from another tab still shows here.
    const timer = setInterval(read, 15_000);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearInterval(timer);
    };
  }, [status]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (status === 'loading') {
    return <span className="wallet-slot" aria-hidden="true" />;
  }

  if (status !== 'signed-in' || !pubkey) {
    return (
      <button
        type="button"
        className="wallet-connect"
        onClick={() => void signIn()}
        disabled={status === 'working'}
      >
        {status === 'working' ? 'Waiting…' : 'Connect'}
      </button>
    );
  }

  return (
    <div className="wallet" ref={box}>
      <button
        type="button"
        className="wallet-pill"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {/* One line, not two. The balance is what is checked on every page, so
            it is the whole pill; the address moved into the menu, where
            identity is looked up rather than monitored. While the balance is
            still being read the address stands in, so the pill is never a row
            of placeholder dots waiting for a number. */}
        <AddressMark pubkey={pubkey} />
        {balance === null ? (
          <span className="wallet-addr">{shortenPubkey(pubkey)}</span>
        ) : split?.ranked ? (
          /* Entered a season: both balances, named, with the one trades are
             currently landing in marked as live. */
          <span className="wallet-split">
            <span className={split.ranked.live ? 'wallet-leg live' : 'wallet-leg'}>
              <em>Ranked</em>
              <b>{(Number(BigInt(split.ranked.balance)) / 1e9).toFixed(2)}</b>
            </span>
            <span className="wallet-leg">
              <em>Free</em>
              <b>{(Number(BigInt(split.free.balance)) / 1e9).toFixed(2)}</b>
            </span>
          </span>
        ) : (
          <span className="wallet-amount">
            {(Number(BigInt(balance)) / 1e9).toFixed(2)}
            <span className="unit">SOL</span>
          </span>
        )}
        <span className="wallet-chevron" aria-hidden="true" />
      </button>

      {open && (
        // A plain disclosure of a few links and a button, not an ARIA menu:
        // role="menu" would promise arrow-key roving focus this does not
        // implement. Every item is a real link or button reachable by Tab, and
        // Escape and click-outside close it.
        <div className="wallet-menu">
          {/* The address, where it is looked up rather than watched. */}
          <span className="wallet-menu-head">{shortenPubkey(pubkey)}</span>
          <a href="/me">Your account</a>
          <a href={`/p/${pubkey}`}>Public record</a>
          <a href="/season">This season</a>
          <button type="button" onClick={() => void signOut()}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The front-page call to action.
 *
 * Signed out it is the one button on the page that matters. Signed in it stops
 * being a sign-in control and becomes a way through to trading, because telling
 * somebody they are signed in is not worth a button and was the whole of what
 * this used to do.
 */
export function SignIn() {
  const { status, pubkey, error, signIn } = useWallet();

  if (status === 'signed-in' && pubkey) {
    return (
      <a href="/feed" className="button-link">
        Pick a token and trade
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        className="button-link"
        onClick={() => void signIn()}
        disabled={status === 'working' || status === 'loading'}
      >
        {status === 'working' ? 'Waiting for your wallet…' : 'Connect Phantom to start'}
      </button>
      {error && (
        <p role="alert" className="dim" style={{ fontSize: 13 }}>
          {error}
        </p>
      )}
    </>
  );
}
