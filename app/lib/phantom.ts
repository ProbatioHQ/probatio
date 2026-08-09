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
