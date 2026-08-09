'use client';

import { useCallback, useEffect, useState } from 'react';
import bs58 from 'bs58';
import { PHANTOM_INSTALL_URL, getPhantom } from '@/lib/phantom';

type State =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'working' }
  | { status: 'signed-in'; pubkey: string }
  | { status: 'error'; message: string };

function shorten(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

export function SignIn() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/session')
      .then((r) => r.json() as Promise<{ pubkey: string | null }>)
      .then((data) => {
        if (cancelled) return;
        setState(data.pubkey ? { status: 'signed-in', pubkey: data.pubkey } : { status: 'signed-out' });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'signed-out' });
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

    setState({ status: 'working' });
    try {
      const { publicKey } = await phantom.connect();
      const pubkey = publicKey.toString();

      const challengeResponse = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey }),
      });
      if (!challengeResponse.ok) {
        throw new Error(((await challengeResponse.json()) as { error: string }).error);
      }
      const { nonce, message } = (await challengeResponse.json()) as {
        nonce: string;
        message: string;
      };

      const { signature } = await phantom.signMessage(new TextEncoder().encode(message), 'utf8');

      const verifyResponse = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey, nonce, signature: bs58.encode(signature) }),
      });
      if (!verifyResponse.ok) {
        throw new Error(((await verifyResponse.json()) as { error: string }).error);
      }

      setState({ status: 'signed-in', pubkey });
    } catch (error) {
      // A user closing the wallet popup is a decision, not a failure.
      const message = error instanceof Error ? error.message : 'Sign-in failed.';
      setState(
        /user rejected|declined/i.test(message)
          ? { status: 'signed-out' }
          : { status: 'error', message },
      );
    }
  }, []);

  const signOut = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setState({ status: 'signed-out' });
  }, []);

  if (state.status === 'loading') {
    return <p aria-live="polite">Checking wallet…</p>;
  }

  if (state.status === 'signed-in') {
    return (
      <div>
        <p>
          Signed in as <strong>{shorten(state.pubkey)}</strong>
        </p>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div>
      <button type="button" onClick={() => void signIn()} disabled={state.status === 'working'}>
        {state.status === 'working' ? 'Waiting for your wallet…' : 'Sign in with Phantom'}
      </button>
      {state.status === 'error' && (
        <p role="alert">{state.message}</p>
      )}
    </div>
  );
}
