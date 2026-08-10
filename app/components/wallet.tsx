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

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/session')
      .then((response) => response.json() as Promise<{ pubkey: string | null }>)
      .then((data) => {
        if (cancelled) return;
        setPubkey(data.pubkey);
        setStatus(data.pubkey ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        if (!cancelled) setStatus('signed-out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    const phantom = getPhantom();
    if (!phantom) {
      window.open(PHANTOM_INSTALL_URL, '_blank', 'noopener,noreferrer');
      return;
    }

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
      // Someone closing the wallet popup made a decision. It is not an error
      // and should not be shown to them as one.
      const message = caught instanceof Error ? caught.message : 'Sign-in failed.';
      setStatus('signed-out');
      setError(/user rejected|declined/i.test(message) ? null : message);
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setPubkey(null);
    setStatus('signed-out');
    setError(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({ status, pubkey, error, signIn, signOut }),
    [status, pubkey, error, signIn, signOut],
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
  const { status, pubkey, signIn, signOut } = useWallet();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'signed-in') {
      setBalance(null);
      return;
    }
    let cancelled = false;
    const read = (): void => {
      void fetch('/api/positions')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { equity?: { equity: string } } | null) => {
          if (!cancelled && data?.equity) setBalance(data.equity.equity);
        })
        .catch(() => undefined);
    };
    read();
    // Equity moves with the market even when the trader does nothing.
    const timer = setInterval(read, 15_000);
    return () => {
      cancelled = true;
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
        <span className="key" aria-hidden="true" />
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
        <AddressMark pubkey={pubkey} />
        <span className="addr">{shortenPubkey(pubkey)}</span>
        {balance !== null && (
          <span className="bal">{(Number(BigInt(balance)) / 1e9).toFixed(2)}◎</span>
        )}
      </button>

      {open && (
        <div className="wallet-menu" role="menu">
          <a href={`/p/${pubkey}`} role="menuitem">
            Your record
          </a>
          <a href="/season" role="menuitem">
            This season
          </a>
          <button type="button" role="menuitem" onClick={() => void signOut()}>
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
      <a href="#feed" className="button-link">
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
