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

/**
 * A phone, where there is no extension to inject a provider.
 *
 * iPads have reported themselves as Macs since iPadOS 13, so the touch count is
 * asked as well: a Mac reports zero touch points and an iPad reports five.
 */
export function isHandheld(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Android|iPhone|iPod/i.test(navigator.userAgent)) return true;
  return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/**
 * The link that reopens this page inside Phantom's own browser.
 *
 * A phone browser has no extension, so there is no provider to connect to and
 * nothing for a connect button to do. Sending somebody to the download page is
 * the wrong answer for the many people who already have Phantom installed: they
 * are told to install what they have, and even after installing it they are
 * still in Safari with no provider, so the button fails again.
 *
 * Phantom's universal link takes a URL and opens it in the wallet's in-app
 * browser, which does inject a provider. So the page comes back up inside
 * Phantom with the connect button working normally. `ref` is the origin asking,
 * which Phantom shows in its own UI so somebody can see who is asking before
 * they approve anything.
 *
 * Both parameters have to be encoded or Phantom reads the target's own query
 * string as its.
 */
export function phantomBrowseUrl(target?: string): string {
  const here = target ?? window.location.href;
  const ref = window.location.origin;
  return `https://phantom.app/ul/browse/${encodeURIComponent(here)}?ref=${encodeURIComponent(ref)}`;
}

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
