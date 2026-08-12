/**
 * The slice of Phantom's injected provider that Probatio uses.
 *
 * Typed narrowly on purpose. The provider exposes transaction signing too, and
 * nothing in this codebase should be able to reach it by accident — signing in
 * must never be one autocomplete away from moving funds.
 */
export interface PhantomProvider {
  readonly isPhantom?: boolean;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding: 'utf8'): Promise<{ signature: Uint8Array }>;
  // The wallet emits these when the user switches or disconnects the active
  // account inside the extension. Without listening, the app keeps the old
  // identity and would sign a payment from a wallet the session does not match.
  on?(event: 'accountChanged' | 'disconnect', handler: (arg?: unknown) => void): void;
  off?(event: 'accountChanged' | 'disconnect', handler: (arg?: unknown) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProvider };
    solana?: PhantomProvider;
  }
}

export const PHANTOM_INSTALL_URL = 'https://phantom.app/download';

/** The injected provider, or null when Phantom is not installed. */
export function getPhantom(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const provider = window.phantom?.solana ?? window.solana;
  return provider?.isPhantom ? provider : null;
}

/**
 * The signing half of the provider, kept apart on purpose.
 *
 * Reaching this takes a separate, differently named call. Signing in and
 * moving funds are different acts, and a component that only needs the first
 * should not be one autocomplete away from the second.
 *
 * `request` is used rather than `signAndSendTransaction` because it accepts a
 * serialized message: the transaction is built and encoded here, so no wallet
 * library ever enters the bundle.
 */
export interface PhantomSigner {
  request(input: {
    method: 'signAndSendTransaction';
    params: { message: string };
  }): Promise<{ signature: string; publicKey?: string }>;
}

export function getPhantomSigner(): PhantomSigner | null {
  const provider = getPhantom() as (PhantomProvider & Partial<PhantomSigner>) | null;
  return provider && typeof provider.request === 'function'
    ? (provider as unknown as PhantomSigner)
    : null;
}
